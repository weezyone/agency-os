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

export async function createMember(rawInput: unknown, principal: Principal) {
  const input = createMemberSchema.parse(rawInput);
  return publicMember(await identityRepository.createMember(input, principalActor(principal)));
}

export async function updateMember(id: string, rawInput: unknown) {
  const input = updateMemberSchema.parse(rawInput);
  const member = await identityRepository.updateMember(id, input);
  if (!member) throw new Error("Member not found or protected owner record cannot be modified");
  return publicMember(member);
}

export async function listMembers() {
  return Promise.all((await identityRepository.listMembers()).map(publicMember));
}

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

export async function listApiKeys(memberId?: string) {
  return identityRepository.listApiKeys(memberId);
}

export async function revokeApiKey(id: string) {
  const key = await identityRepository.revokeApiKey(id);
  if (!key) throw new Error("API key not found or already revoked");
  return key;
}
