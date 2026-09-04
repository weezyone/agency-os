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

export const tenantRepository = {
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

  async getCurrent() {
    const { tenants } = await collections();
    return tenants.findOne({ id: currentTenantId() }, { projection: { _id: 0 } });
  },

  async getById(id: string) {
    const { tenants } = await collections();
    return tenants.findOne(tenantFilter({ id }), { projection: { _id: 0 } });
  },

  async getBySlug(slug: string) {
    const { tenants } = await collections();
    return tenants.findOne({ slug: slug.trim().toLowerCase(), status: "active" }, { projection: { _id: 0 } });
  },

  async getActiveById(id: string) {
    const { tenants } = await collections();
    return tenants.findOne({ id, status: "active" }, { projection: { _id: 0 } });
  },

  async updateCurrent(input: UpdateTenantInput) {
    const { tenants } = await collections();
    return tenants.findOneAndUpdate(
      { id: currentTenantId() },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async setActivePolicy(policyId: string, session?: ClientSession) {
    const { tenants } = await collections();
    return tenants.findOneAndUpdate(
      { id: currentTenantId() },
      { $set: { activePolicyId: policyId, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 }, session },
    );
  },

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

  async listInvitations() {
    const { invitations } = await collections();
    return invitations.find(tenantFilter(), { projection: { _id: 0, tokenHash: 0 } }).sort({ createdAt: -1 }).toArray();
  },

  async verifyInvitation(token: string) {
    const id = invitationId(token);
    if (!id) return null;
    const { invitations } = await collections();
    const invitation = await invitations.findOne({ id }, { projection: { _id: 0 } });
    if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) return null;
    return safeHexEqual(invitation.tokenHash, hash(token)) ? invitation : null;
  },

  async acceptInvitation(id: string, memberId: string) {
    const { invitations } = await collections();
    return invitations.findOneAndUpdate(
      tenantFilter({ id, acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }),
      { $set: { acceptedAt: new Date(), acceptedByMemberId: memberId } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0 } },
    );
  },

  async revokeInvitation(id: string) {
    const { invitations } = await collections();
    return invitations.findOneAndUpdate(
      tenantFilter({ id, acceptedAt: null, revokedAt: null }),
      { $set: { revokedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0, tokenHash: 0 } },
    );
  },

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

  async getOidcForTenant(tenantId: string) {
    const { oidcConnections } = await collections();
    return oidcConnections.findOne({ tenantId, status: "active" }, { projection: { _id: 0 } });
  },

  async createOidcTransaction(input: Omit<OidcTransaction, "id" | "createdAt" | "consumedAt" | "stateHash"> & { state: string }) {
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

  async consumeOidcTransaction(state: string) {
    const { oidcTransactions } = await collections();
    return oidcTransactions.findOneAndUpdate(
      { stateHash: hash(state), consumedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date() } },
      { returnDocument: "before", projection: { _id: 0 } },
    );
  },
};
