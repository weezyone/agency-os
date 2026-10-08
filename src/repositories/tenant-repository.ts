import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ClientSession } from "mongodb";
import { env } from "@/lib/env";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { getDb } from "@/lib/mongodb";
import { lazyAsync } from "@/lib/lazy-async";
import type {
  ConfigureOidcConnectionInput,
  CreateTenantInput,
  CreateTenantInvitationInput,
  OidcConnection,
  OidcTransaction,
  Tenant,
  TenantInvitation,
  UpdateTenantInput,
} from "@/schemas/tenant";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const tenants = db.collection<Tenant>("tenants");
  const invitations = db.collection<TenantInvitation>("tenant_invitations");
  const oidcConnections = db.collection<OidcConnection>("tenant_oidc_connections");
  const oidcTransactions = db.collection<OidcTransaction>("oidc_transactions");

  await Promise.all([
    tenants.createIndex({ id: 1 }, { unique: true }),
    tenants.createIndex({ slug: 1 }, { unique: true }),
    tenants.createIndex({ status: 1, updatedAt: -1 }),
    invitations.createIndex({ id: 1 }, { unique: true }),
    invitations.createIndex({ tokenHash: 1 }, { unique: true }),
    invitations.createIndex({ tenantId: 1, email: 1, createdAt: -1 }),
    invitations.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    oidcConnections.createIndex({ id: 1 }, { unique: true }),
    oidcConnections.createIndex({ tenantId: 1 }, { unique: true }),
    oidcTransactions.createIndex({ id: 1 }, { unique: true }),
    oidcTransactions.createIndex({ stateHash: 1 }, { unique: true }),
    oidcTransactions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  return { tenants, invitations, oidcConnections, oidcTransactions };
});

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Token comparisons are timing-safe so an attacker cannot recover a stored
// hash incrementally by measuring response latency. The length check comes
// first because timingSafeEqual throws on mismatched lengths.
function safeHexEqual(left: string, right: string) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function invitationCredential() {
  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, token: `aoi_${id}_${secret}` };
}

function invitationId(token: string) {
  return /^aoi_([0-9a-f-]{36})_[A-Za-z0-9_-]+$/i.exec(token.trim())?.[1] ?? null;
}

/**
 * Store for tenants, invitations, and OIDC connections/transactions.
 *
 * Invitation tokens and OIDC state values are persisted only as SHA-256
 * hashes, so a database leak discloses neither usable invite links nor
 * in-flight login state.
 */
export const tenantRepository = {
  /**
   * Creates the single-tenant bootstrap tenant from environment config if absent.
   *
   * @returns The existing or newly created bootstrap tenant.
   */
  async ensureBootstrapTenant() {
    const { tenants } = await collections();
    const tenantId = env().AGENCY_TENANT_ID;
    const existing = await tenants.findOne({ id: tenantId }, { projection: { _id: 0 } });
    if (existing) return existing;
    const now = new Date();
    const tenant: Tenant = {
      id: tenantId,
      slug: tenantId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 63) || "agency-default",
      displayName: env().AGENCY_BOOTSTRAP_OWNER_NAME || "AgencyOS",
      status: "active",
      allowedEmailDomains: [],
      activePolicyId: null,
      oidcConnectionId: null,
      createdBy: "system:bootstrap",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await tenants.insertOne(tenant);
      return tenant;
    } catch {
      return tenants.findOne({ id: tenantId }, { projection: { _id: 0 } });
    }
  },

  /**
   * @param input - Tenant fields (slug, display name, allowed email domains).
   * @param createdBy - Actor id recorded as creator.
   * @param session - Optional MongoDB transaction session.
   * @returns The created tenant.
   */
  async create(input: CreateTenantInput, createdBy: string, session?: ClientSession) {
    const { tenants } = await collections();
    const now = new Date();
    const tenant: Tenant = {
      id: randomUUID(),
      ...input,
      status: "active",
      activePolicyId: null,
      oidcConnectionId: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    await tenants.insertOne(tenant, { session });
    return tenant;
  },

  /**
   * @returns The tenant of the current context, or null when it does not exist.
   */
  async getCurrent() {
    const { tenants } = await collections();
    return tenants.findOne({ id: currentTenantId() }, { projection: { _id: 0 } });
  },

  /**
   * @param id - Tenant id; must match the current tenant context.
   * @returns The tenant, or null when not found.
   */
  async getById(id: string) {
    const { tenants } = await collections();
    return tenants.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  /**
   * Looks up an active tenant by slug without requiring a tenant context
   * (used during sign-in, before any context exists).
   *
   * @param slug - Tenant slug, normalized to lowercase.
   * @returns The active tenant, or null when not found.
   */
  async getBySlug(slug: string) {
    const { tenants } = await collections();
    return tenants.findOne({ slug: slug.trim().toLowerCase(), status: "active" }, { projection: { _id: 0 } });
  },

  /**
   * @param id - Tenant id, without requiring a matching tenant context.
   * @returns The tenant when it exists and is active, otherwise null.
   */
  async getActiveById(id: string) {
    const { tenants } = await collections();
    return tenants.findOne({ id, status: "active" }, { projection: { _id: 0 } });
  },

  /**
   * @param input - Fields to update on the current tenant.
   * @returns The updated tenant, or null when the current tenant does not exist.
   */
  async updateCurrent(input: UpdateTenantInput) {
    const { tenants } = await collections();
    return tenants.findOneAndUpdate(
      { id: currentTenantId() },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  /**
   * Points the current tenant at a policy version; called inside the policy
   * activation transaction so the pointer never disagrees with policy status.
   *
   * @param policyId - Policy id to make active.
   * @param session - Optional MongoDB transaction session.
   * @returns The updated tenant, or null when it does not exist.
   */
  async setActivePolicy(policyId: string, session?: ClientSession) {
    const { tenants } = await collections();
    return tenants.findOneAndUpdate(
      { id: currentTenantId() },
      { $set: { activePolicyId: policyId, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 }, session },
    );
  },

  /**
   * Creates an email invitation to join the current tenant.
   *
   * @param input - Invitee email, role, and expiry in hours.
   * @param invitedBy - Member id of the inviter.
   * @returns The stored invitation plus the plaintext token, shared with the
   *   invitee exactly once (only its hash is persisted).
   */
  async createInvitation(input: CreateTenantInvitationInput, invitedBy: string) {
    const { invitations } = await collections();
    const credential = invitationCredential();
    const now = new Date();
    const invitation: TenantInvitation = {
      id: credential.id,
      tenantId: currentTenantId(),
      email: input.email.trim().toLowerCase(),
      role: input.role,
      tokenHash: hash(credential.token),
      invitedBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.expiresInHours * 60 * 60 * 1_000),
      acceptedAt: null,
      acceptedByMemberId: null,
      revokedAt: null,
    };
    await invitations.insertOne(invitation);
    return { invitation, token: credential.token };
  },

  /**
   * @returns The tenant's invitations without token hashes, newest first.
   */
  async listInvitations() {
    const { invitations } = await collections();
    return invitations.find(tenantFilter(), { projection: { _id: 0, tokenHash: 0 } }).sort({ createdAt: -1 }).toArray();
  },

  /**
   * Verifies an invitation token without consuming it.
   *
   * Lookup is by the id embedded in the token, then timing-safe hash
   * comparison of the secret; revoked, accepted, and expired invitations all
   * return null so callers cannot probe invitation states.
   *
   * @param token - The `aoi_...` invitation token.
   * @returns The valid pending invitation, otherwise null.
   */
  async verifyInvitation(token: string) {
    const id = invitationId(token);
    if (!id) return null;
    const { invitations } = await collections();
    const invitation = await invitations.findOne({ id }, { projection: { _id: 0 } });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) return null;
    return safeHexEqual(invitation.tokenHash, hash(token)) ? invitation : null;
  },

  /**
   * Marks an invitation as accepted exactly once.
   *
   * The filter requires it to be unaccepted, unrevoked, and unexpired, so two
   * concurrent acceptances cannot both succeed against one invitation.
   *
   * @param id - Invitation id within the current tenant.
   * @param memberId - Member created by accepting the invitation.
   * @returns The accepted invitation (token hash omitted), or null when no longer acceptable.
   */
  async acceptInvitation(id: string, memberId: string) {
    const { invitations } = await collections();
    return invitations.findOneAndUpdate(
      tenantFilter({ id, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }),
      { $set: { acceptedAt: new Date(), acceptedByMemberId: memberId } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0 } },
    );
  },

  /**
   * @param id - Invitation id within the current tenant.
   * @returns The revoked invitation (token hash omitted), or null when not pending.
   */
  async revokeInvitation(id: string) {
    const { invitations } = await collections();
    return invitations.findOneAndUpdate(
      tenantFilter({ id, acceptedAt: null, revokedAt: null }),
      { $set: { revokedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0 } },
    );
  },

  /**
   * Creates or replaces the tenant's single OIDC connection.
   *
   * The client secret is never stored here — `clientSecretId` references an
   * envelope-encrypted entry in the secret repository.
   *
   * @param input - Issuer, client id, scopes, and the secret reference id.
   * @param createdBy - Actor id recorded as creator on first configuration.
   * @returns The stored connection.
   */
  async configureOidc(input: Omit<ConfigureOidcConnectionInput, "clientSecret"> & { clientSecretId: string }, createdBy: string) {
    const { oidcConnections, tenants } = await collections();
    const now = new Date();
    const current = await oidcConnections.findOne({ tenantId: currentTenantId() }, { projection: { _id: 0 } });
    const connection: OidcConnection = {
      id: current?.id ?? randomUUID(),
      tenantId: currentTenantId(),
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretId: input.clientSecretId,
      scopes: input.scopes,
      status: "active",
      createdBy: current?.createdBy ?? createdBy,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await oidcConnections.replaceOne({ tenantId: currentTenantId() }, connection, { upsert: true });
    await tenants.updateOne({ id: currentTenantId() }, { $set: { oidcConnectionId: connection.id, updatedAt: now } });
    return connection;
  },

  /**
   * @param tenantId - Tenant whose OIDC connection should be loaded.
   * @returns The active connection, or null when OIDC is not configured.
   */
  async getOidcForTenant(tenantId: string) {
    const { oidcConnections } = await collections();
    return oidcConnections.findOne({ tenantId, status: "active" }, { projection: { _id: 0 } });
  },

  /**
   * Persists an in-flight OIDC login (PKCE verifier, nonce, return target).
   *
   * Only the hash of `state` is stored, so leaked rows cannot be used to
   * correlate or complete someone else's login. Rows self-delete via TTL.
   *
   * @param input - Transaction fields plus the plaintext `state` to hash.
   * @returns The created transaction record.
   */
  async createOidcTransaction(input: Omit<OidcTransaction, "id" | "createdAt" | "consumedAt"> & { state: string }) {
    const { oidcTransactions } = await collections();
    const now = new Date();
    const record: OidcTransaction = {
      id: randomUUID(),
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      stateHash: hash(input.state),
      codeVerifierCiphertext: input.codeVerifierCiphertext,
      nonceCiphertext: input.nonceCiphertext,
      invitationId: input.invitationId,
      returnTo: input.returnTo,
      createdAt: now,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    await oidcTransactions.insertOne(record);
    return record;
  },

  /**
   * Consumes an OIDC transaction atomically, returning its pre-consumption state.
   *
   * The atomic find-and-update on `consumedAt: null` is the replay guard: an
   * authorization code callback can be processed exactly once, so a captured
   * callback URL cannot mint a second session.
   *
   * @param state - The plaintext `state` parameter from the OIDC callback.
   * @returns The transaction as it was before consumption, or null when
   *   unknown, expired, or already consumed.
   */
  async consumeOidcTransaction(state: string) {
    const { oidcTransactions } = await collections();
    return oidcTransactions.findOneAndUpdate(
      { stateHash: hash(state), consumedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { returnDocument: "before", projection: { _id: 0 } },
    );
  },
};
