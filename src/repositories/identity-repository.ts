import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ClientSession } from "mongodb";
import { env } from "@/lib/env";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb, listCollectionIndexes } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import type {
  ApiKeyRecord,
  BrowserSession,
  CreateApiKeyInput,
  CreateMemberInput,
  Member,
  MemberRole,
  UpdateMemberInput,
} from "@/schemas/identity";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const members = db.collection<Member>("agency_members");
  const apiKeys = db.collection<ApiKeyRecord>("agency_api_keys");
  const sessions = db.collection<BrowserSession>("browser_sessions");

  await Promise.all([
    members.updateMany(
      { tenantId: { $exists: false } },
      [{ $set: {
        tenantId: env().AGENCY_TENANT_ID,
        identityProvider: { $ifNull: ["$identityProvider", "local"] },
        subject: { $ifNull: ["$subject", null] },
      } }],
    ),
    apiKeys.updateMany(
      { tenantId: { $exists: false } },
      [{ $set: { tenantId: env().AGENCY_TENANT_ID } }],
    ),
  ]);

  // Drop the M6 global-email index when it exists. M7 allows the same identity
  // to be invited into multiple tenants while keeping email unique per tenant.
  const memberIndexes = await listCollectionIndexes(members);
  const globalEmailIndex = memberIndexes.find((index) => index.unique && index.key?.email === 1 && Object.keys(index.key).length === 1);
  if (globalEmailIndex?.name) await members.dropIndex(globalEmailIndex.name).catch(() => undefined);

  // A compound sparse index still indexes a document when tenantId exists,
  // even if subject is null. Use a partial index so multiple local/invited
  // members without OIDC subjects can coexist safely inside one tenant.
  const subjectIndexName = "tenant_subject_unique_partial_v7";
  const legacySubjectIndexes = memberIndexes.filter((index) =>
    index.name !== subjectIndexName
      && index.key?.tenantId === 1
      && index.key?.subject === 1
      && Object.keys(index.key).length === 2
  );
  for (const index of legacySubjectIndexes) {
    if (index.name) await members.dropIndex(index.name).catch(() => undefined);
  }

  await Promise.all([
    members.createIndex({ id: 1 }, { unique: true }),
    members.createIndex({ tenantId: 1, email: 1 }, { unique: true }),
    members.createIndex(
      { tenantId: 1, subject: 1 },
      {
        name: subjectIndexName,
        unique: true,
        partialFilterExpression: { subject: { $type: "string" } },
      },
    ),
    members.createIndex({ tenantId: 1, role: 1, status: 1, createdAt: 1 }),
    apiKeys.createIndex({ id: 1 }, { unique: true }),
    apiKeys.createIndex({ tenantId: 1, memberId: 1, revokedAt: 1, createdAt: -1 }),
    apiKeys.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ id: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ tenantId: 1, memberId: 1, revokedAt: 1, expiresAt: 1 }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  return { members, apiKeys, sessions };
});

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Credential comparisons are timing-safe: a naive string compare would leak
// how many prefix bytes matched and let an attacker recover hashes/token
// material incrementally. The length check comes first because
// timingSafeEqual throws on mismatched lengths.
function safeEqualHex(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function createCredential(prefix: "aos" | "aos_session") {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const token = `${prefix}_${id}_${secret}`;
  return { id, token, prefix: `${prefix}_${id.slice(0, 8)}` };
}

function credentialId(token: string, prefix: "aos" | "aos_session") {
  const expression = prefix === "aos"
    ? /^aos_([0-9a-f-]{36})_[A-Za-z0-9_-]+$/i
    : /^aos_session_([0-9a-f-]{36})_[A-Za-z0-9_-]+$/i;
  return expression.exec(token.trim())?.[1] ?? null;
}

function optionalRequestHash(value: string | null | undefined) {
  return value ? tokenHash(value) : null;
}

async function persistApiKey(
  member: Member,
  input: { name: string; expiresAt: Date | null; createdBy: string },
  session?: ClientSession,
) {
  const { apiKeys } = await collections();
  const credential = createCredential("aos");
  const now = new Date();
  const record: ApiKeyRecord = {
    id: credential.id,
    tenantId: member.tenantId,
    memberId: member.id,
    name: input.name,
    prefix: credential.prefix,
    tokenHash: tokenHash(credential.token),
    createdBy: input.createdBy,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: input.expiresAt,
    revokedAt: null,
  };
  await apiKeys.insertOne(record, { session });
  return { record, token: credential.token };
}

/**
 * Tenant-scoped store for members, API keys, and browser sessions.
 *
 * API keys and session/CSRF tokens are persisted only as SHA-256 hashes, so a
 * database leak never discloses usable credentials. Tokens embed their record
 * id, letting authentication look up the candidate by id and then verify the
 * secret with a timing-safe hash comparison.
 */
export const identityRepository = {
  /**
   * Creates a local (non-OIDC) member in a tenant.
   *
   * @param input - Member attributes (email is normalized to lowercase).
   * @param createdBy - Actor id recorded as creator.
   * @param tenantId - Target tenant; defaults to the current tenant context.
   * @returns The created member.
   * @throws {Error} If the email is already registered in the tenant.
   */
  async createMember(input: CreateMemberInput, createdBy: string, tenantId = currentTenantId()) {
    const { members } = await collections();
    const email = normalizeEmail(input.email);
    const existing = await members.findOne({ tenantId, email }, { projection: { _id: 0 } });
    if (existing) throw new Error("An agency member with this email already exists in the tenant");

    const now = new Date();
    const member: Member = {
      id: randomUUID(),
      tenantId,
      email,
      displayName: input.displayName,
      role: input.role,
      status: "active",
      identityProvider: "local",
      subject: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: null,
    };
    await members.insertOne(member);
    return member;
  },

  /**
   * Creates the owner member of a new tenant, idempotent on email, as part of
   * the tenant-creation transaction.
   *
   * @param input - Tenant id, owner email/display name, and creator actor.
   * @param session - Optional MongoDB transaction session.
   * @returns The existing or newly created owner member.
   */
  async createOwnerMember(input: { tenantId: string; email: string; displayName: string; createdBy: string }, session?: ClientSession) {
    const { members } = await collections();
    const email = normalizeEmail(input.email);
    const existing = await members.findOne({ tenantId: input.tenantId, email }, { projection: { _id: 0 }, session });
    if (existing) return existing;
    const now = new Date();
    const member: Member = {
      id: randomUUID(), tenantId: input.tenantId, email, displayName: input.displayName, role: "owner",
      status: "active", identityProvider: "local", subject: null, createdBy: input.createdBy,
      createdAt: now, updatedAt: now, lastAuthenticatedAt: null,
    };
    await members.insertOne(member, { session });
    return member;
  },

  /**
   * Creates or links a tenant membership from an OIDC identity.
   *
   * An existing membership matched by email or subject is linked to the OIDC
   * subject. Refusing to link when email and subject resolve to *different*
   * members (or when the stored subject changed) prevents an identity provider
   * from hijacking an existing local account by email collision.
   *
   * @param input - Tenant id, verified OIDC claims, role, and creator actor.
   * @returns The linked or newly created member.
   * @throws {Error} If the OIDC identity conflicts with an existing membership.
   */
  async createOidcMember(input: {
    tenantId: string;
    email: string;
    displayName: string;
    role: MemberRole;
    subject: string;
    createdBy: string;
  }) {
    const { members } = await collections();
    const email = normalizeEmail(input.email);
    const [existingByEmail, existingBySubject] = await Promise.all([
      members.findOne({ tenantId: input.tenantId, email }, { projection: { _id: 0 } }),
      members.findOne({ tenantId: input.tenantId, subject: input.subject }, { projection: { _id: 0 } }),
    ]);
    if (existingByEmail && existingBySubject && existingByEmail.id !== existingBySubject.id) {
      throw new Error("OIDC email and subject resolve to different tenant memberships");
    }
    const existing = existingBySubject ?? existingByEmail;
    if (existing) {
      if (existing.subject && existing.subject !== input.subject) {
        throw new Error("OIDC subject does not match the existing tenant membership");
      }
      return members.findOneAndUpdate(
        { id: existing.id, tenantId: input.tenantId },
        {
          $set: {
            email,
            identityProvider: "oidc",
            subject: input.subject,
            displayName: input.displayName || existing.displayName,
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after", projection: { _id: 0 } },
      );
    }
    const now = new Date();
    const member: Member = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email,
      displayName: input.displayName,
      role: input.role,
      status: "active",
      identityProvider: "oidc",
      subject: input.subject,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: null,
    };
    await members.insertOne(member);
    return member;
  },

  /**
   * Updates a member's mutable fields; owner accounts cannot be demoted or
   * disabled here (returning null) so a tenant cannot lock out its last owner.
   *
   * @param id - Member id within the current tenant.
   * @param input - Fields to update.
   * @returns The updated member, or null when not found or the change is forbidden.
   */
  async updateMember(id: string, input: UpdateMemberInput) {
    const { members } = await collections();
    const current = await members.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
    if (!current) return null;
    if (current.role === "owner" && (input.role || input.status === "disabled")) return null;

    return members.findOneAndUpdate(
      tenantFilter({ id }),
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  /**
   * @returns All members of the current tenant, oldest first.
   */
  async listMembers() {
    const { members } = await collections();
    return members.find(tenantFilter(), { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  },

  /**
   * @param id - Member id within the current tenant.
   * @returns The member, or null when not found.
   */
  async getMember(id: string) {
    const { members } = await collections();
    return members.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  /**
   * @param email - Member email (normalized before lookup).
   * @param tenantId - Tenant to search; defaults to the current tenant context.
   * @returns The member, or null when not found.
   */
  async getMemberByEmail(email: string, tenantId = currentTenantId()) {
    const { members } = await collections();
    return members.findOne({ tenantId, email: normalizeEmail(email) }, { projection: { _id: 0 } });
  },

  /**
   * Issues an API key for an active member of the current tenant.
   *
   * @param input - Target member, key name, optional expiry, and creator actor.
   * @returns The stored record plus the plaintext token, shown to the caller
   *   exactly once (only its hash is persisted).
   * @throws {Error} If the member is not active in the current tenant.
   */
  async createApiKey(input: CreateApiKeyInput & { createdBy: string }) {
    const { members } = await collections();
    const member = await members.findOne(tenantFilter({ id: input.memberId, status: "active" }), { projection: { _id: 0 } });
    if (!member) throw new Error("Member not found in the current tenant");
    return persistApiKey(member, {
      name: input.name,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    });
  },

  /**
   * Issues the first API key during tenant bootstrap, inside the creation transaction.
   *
   * Restricted to the active tenant owner: bootstrap must not mint credentials
   * for lesser roles before the tenant's membership is established.
   *
   * @param member - The tenant owner receiving the key.
   * @param input - Key name, creator actor, and optional expiry.
   * @param session - Optional MongoDB transaction session.
   * @returns The stored record plus the plaintext token (only its hash is persisted).
   * @throws {Error} If the member is not the active tenant owner.
   */
  async createInitialTenantApiKey(
    member: Member,
    input: { name: string; createdBy: string; expiresAt?: Date | null },
    session?: ClientSession,
  ) {
    if (member.role !== "owner" || member.status !== "active") {
      throw new Error("Initial tenant API keys may be issued only to the active tenant owner");
    }
    return persistApiKey(member, {
      name: input.name,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    }, session);
  },

  /**
   * @param memberId - Optional member filter within the current tenant.
   * @returns API key records without token hashes, newest first.
   */
  async listApiKeys(memberId?: string) {
    const { apiKeys } = await collections();
    return apiKeys
      .find(tenantFilter(memberId ? { memberId } : {}), { projection: { _id: 0, tokenHash: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
  },

  /**
   * @param id - API key id within the current tenant.
   * @returns The revoked key (hash omitted), or null when not found or already revoked.
   */
  async revokeApiKey(id: string) {
    const { apiKeys } = await collections();
    return apiKeys.findOneAndUpdate(
      tenantFilter({ id, revokedAt: null }),
      { $set: { revokedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0 } },
    );
  },

  /**
   * Authenticates an API key token and touches last-used timestamps.
   *
   * Lookup is by the id embedded in the token; the secret is then compared via
   * timing-safe hash equality, and revoked/expired keys and inactive members
   * are rejected. Every failure path returns null so callers cannot
   * distinguish "unknown key" from "wrong secret" or "disabled member".
   *
   * @param token - The `aos_...` API key token.
   * @returns The key and owning member on success, otherwise null.
   */
  async authenticateApiKey(token: string) {
    const id = credentialId(token, "aos");
    if (!id) return null;
    const { members, apiKeys } = await collections();
    const key = await apiKeys.findOne({ id }, { projection: { _id: 0 } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) return null;
    if (!safeEqualHex(key.tokenHash, tokenHash(token))) return null;

    const member = await members.findOne({ id: key.memberId, tenantId: key.tenantId, status: "active" }, { projection: { _id: 0 } });
    if (!member) return null;
    const now = new Date();
    await Promise.all([
      apiKeys.updateOne({ id: key.id, tenantId: key.tenantId }, { $set: { lastUsedAt: now } }),
      members.updateOne({ id: member.id, tenantId: member.tenantId }, { $set: { lastAuthenticatedAt: now } }),
    ]);
    return {
      key: { ...key, lastUsedAt: now },
      member: { ...member, lastAuthenticatedAt: now },
    };
  },

  /**
   * Creates a browser session with a session token and a separate CSRF token.
   *
   * Both are stored hashed; user agent and IP are hashed too so session theft
   * indicators are available without retaining PII. The session row expires
   * via MongoDB TTL.
   *
   * @param member - Member the session belongs to.
   * @param metadata - Optional request metadata (user agent, IP).
   * @returns The stored session plus the one-time plaintext session and CSRF tokens.
   */
  async createBrowserSession(member: Member, metadata: { userAgent?: string | null; ip?: string | null } = {}) {
    const { sessions } = await collections();
    const credential = createCredential("aos_session");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const session: BrowserSession = {
      id: credential.id,
      tenantId: member.tenantId,
      memberId: member.id,
      tokenHash: tokenHash(credential.token),
      csrfTokenHash: tokenHash(csrfToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + env().AGENCY_SESSION_TTL_HOURS * 60 * 60 * 1_000),
      lastSeenAt: now,
      revokedAt: null,
      userAgentHash: optionalRequestHash(metadata.userAgent),
      ipHash: optionalRequestHash(metadata.ip),
    };
    await sessions.insertOne(session);
    return { session, token: credential.token, csrfToken };
  },

  /**
   * Authenticates a browser session token.
   *
   * `lastSeenAt` is throttled to one write per minute so high-traffic sessions
   * do not turn every request into two writes. All failure modes return null.
   *
   * @param token - The `aos_session_...` session token.
   * @returns The session and owning active member on success, otherwise null.
   */
  async authenticateBrowserSession(token: string) {
    const id = credentialId(token, "aos_session");
    if (!id) return null;
    const { members, sessions } = await collections();
    const session = await sessions.findOne({ id }, { projection: { _id: 0 } });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    if (!safeEqualHex(session.tokenHash, tokenHash(token))) return null;
    const member = await members.findOne({ id: session.memberId, tenantId: session.tenantId, status: "active" }, { projection: { _id: 0 } });
    if (!member) return null;
    const now = new Date();
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await Promise.all([
        sessions.updateOne({ id: session.id, tenantId: session.tenantId }, { $set: { lastSeenAt: now } }),
        members.updateOne({ id: member.id, tenantId: member.tenantId }, { $set: { lastAuthenticatedAt: now } }),
      ]);
    }
    return { session: { ...session, lastSeenAt: now }, member };
  },

  /**
   * Checks a CSRF token against a live session using timing-safe comparison.
   *
   * @param sessionId - Session id within the current tenant.
   * @param token - CSRF token from the request.
   * @returns True when the session is unrevoked, unexpired, and the token matches.
   */
  async verifyCsrf(sessionId: string, token: string) {
    const { sessions } = await collections();
    const session = await sessions.findOne(tenantFilter({ id: sessionId, revokedAt: null, expiresAt: { $gt: new Date() } }), { projection: { _id: 0 } });
    return Boolean(session && safeEqualHex(session.csrfTokenHash, tokenHash(token)));
  },

  /**
   * @param id - Session id within the current tenant.
   * @returns The revoked session (hashes omitted), or null when not found or already revoked.
   */
  async revokeBrowserSession(id: string) {
    const { sessions } = await collections();
    return sessions.findOneAndUpdate(
      tenantFilter({ id, revokedAt: null }),
      { $set: { revokedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0, csrfTokenHash: 0 } },
    );
  },

  /**
   * Revokes all live sessions of a member (e.g. on disable or credential reset).
   *
   * @param memberId - Member id within the current tenant.
   * @returns The MongoDB update result.
   */
  async revokeMemberSessions(memberId: string) {
    const { sessions } = await collections();
    return sessions.updateMany(tenantFilter({ memberId, revokedAt: null }), { $set: { revokedAt: new Date() } });
  },
};
