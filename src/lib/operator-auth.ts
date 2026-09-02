import { createHash, timingSafeEqual } from "node:crypto";

export class OperatorUnauthorizedError extends Error {
  constructor(message = "Operator authorization required") {
    super(message);
    this.name = "OperatorUnauthorizedError";
  }
}

export function operatorAuthEnabled() {
  return process.env.AGENCY_REQUIRE_OPERATOR_AUTH?.toLowerCase() === "true";
}

function tokenFromRequest(request: Request) {
  const explicit = request.headers.get("x-agency-operator-token")?.trim();
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function validOperatorToken(candidate: string | null) {
  if (!operatorAuthEnabled()) return true;
  const expected = process.env.AGENCY_OPERATOR_TOKEN;
  if (!candidate || !expected || expected.length < 32) return false;
  return timingSafeEqual(digest(expected), digest(candidate));
}

export function assertOperator(request: Request) {
  if (!validOperatorToken(tokenFromRequest(request))) throw new OperatorUnauthorizedError();
}
