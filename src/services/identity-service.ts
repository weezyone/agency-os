import { identityRepository } from "@/repositories/identity-repository";
import {
  createApiKeySchema,
  createMemberSchema,
  updateMemberSchema,
  type Principal,
} from "@/schemas/identity";
import { principalActor } from "@/lib/authorization";

function publicMember<T extends { id: string; email: string; displayName: string; role: string; status: string; createdBy: string; createdAt: Date; updatedAt: Date; lastAuthenticatedAt: Date | null }>(member: T) {
  return member;
}

/**
 * Creates a tenant member from raw input.
 *
 * @param rawInput Raw member payload, parsed against `createMemberSchema`.
 * @param principal Principal performing the creation (recorded as creator).
 * @returns The public member record.
 * @throws When the input fails schema validation.
 */
export async function createMember(rawInput: unknown, principal: Principal) {
  const input = createMemberSchema.parse(rawInput);
  return publicMember(await identityRepository.createMember(input, principalActor(principal)));
}

/**
 * Updates a tenant member's mutable fields.
 *
 * @param id Member identifier.
 * @param rawInput Raw update payload, parsed against `updateMemberSchema`.
 * @returns The updated public member record.
 * @throws When the input is invalid, the member does not exist, or the target
 *   is a protected owner record.
 */
export async function updateMember(id: string, rawInput: unknown) {
  const input = updateMemberSchema.parse(rawInput);
  const member = await identityRepository.updateMember(id, input);
  if (!member) throw new Error("Member not found or protected owner record cannot be modified");
  return publicMember(member);
}

/**
 * Lists all members of the current tenant in their public shape.
 *
 * @returns Public member records.
 */
export async function listMembers() {
  return Promise.all((await identityRepository.listMembers()).map(publicMember));
}

/**
 * Issues an API key for an active tenant member. The plaintext token is
 * returned exactly once in this response — only its hash is persisted — so
 * callers must store it immediately.
 *
 * @param rawInput Raw key payload, parsed against `createApiKeySchema`.
 * @param principal Principal performing the issuance (recorded as creator).
 * @returns The public key metadata, the one-time plaintext token, and a
 *   storage warning.
 * @throws When the input is invalid or no active member matches.
 */
export async function issueApiKey(rawInput: unknown, principal: Principal) {
  const input = createApiKeySchema.parse(rawInput);
  const member = await identityRepository.getMember(input.memberId);
  if (!member || member.status !== "active") throw new Error("Active member not found");
  const issued = await identityRepository.createApiKey({
    memberId: member.id,
    name: input.name,
    expiresAt: input.expiresAt ?? null,
    createdBy: principalActor(principal),
  });
  return {
    key: {
      id: issued.record.id,
      memberId: issued.record.memberId,
      name: issued.record.name,
      prefix: issued.record.prefix,
      createdBy: issued.record.createdBy,
      createdAt: issued.record.createdAt,
      lastUsedAt: issued.record.lastUsedAt,
      expiresAt: issued.record.expiresAt,
      revokedAt: issued.record.revokedAt,
    },
    token: issued.token,
    warning: "This API key is shown once. Store it in a secure secret manager.",
  };
}

/**
 * Lists API keys for the current tenant, optionally narrowed to one member.
 * Returned records never contain token material.
 *
 * @param memberId Optional member filter.
 * @returns API key metadata records.
 */
export async function listApiKeys(memberId?: string) {
  return identityRepository.listApiKeys(memberId);
}

/**
 * Revokes an API key so it can no longer authenticate.
 *
 * @param id API key identifier.
 * @returns The revoked key record.
 * @throws When the key does not exist or is already revoked.
 */
export async function revokeApiKey(id: string) {
  const key = await identityRepository.revokeApiKey(id);
  if (!key) throw new Error("API key not found or already revoked");
  return key;
}
