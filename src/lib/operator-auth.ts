import { createHash, timingSafeEqual } from "node:crypto";

/** Thrown when a request fails legacy operator-token authorization. */
export class OperatorUnauthorizedError extends Error {
  constructor(message = "Operator authorization required") {
    super(message);
    this.name = "OperatorUnauthorizedError";
  }
}

/** Reports whether legacy operator-token enforcement is switched on. */
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

/**
 * Validates a candidate operator token against `AGENCY_OPERATOR_TOKEN`.
 * Always true when operator auth is disabled. Comparison runs on SHA-256
 * digests so `timingSafeEqual` never sees attacker-controlled lengths and
 * token length/timing is not leaked. Tokens shorter than 32 chars are rejected.
 *
 * @param candidate - Token presented by the caller, if any.
 */
export function validOperatorToken(candidate: string | null) {
  if (!operatorAuthEnabled()) return true;
  const expected = process.env.AGENCY_OPERATOR_TOKEN;
  if (!candidate || !expected || expected.length < 32) return false;
  return timingSafeEqual(digest(expected), digest(candidate));
}

/**
 * Requires the request to carry a valid operator token in the
 * `x-agency-operator-token` header or an `Authorization: Bearer` header.
 *
 * @param request - Incoming HTTP request.
 * @throws {OperatorUnauthorizedError} When the token is missing or invalid.
 */
export function assertOperator(request: Request) {
  if (!validOperatorToken(tokenFromRequest(request))) throw new OperatorUnauthorizedError();
}
