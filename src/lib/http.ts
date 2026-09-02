import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthenticationRequiredError, CsrfValidationError, PermissionDeniedError } from "@/lib/authorization";
import { OperatorUnauthorizedError } from "@/lib/operator-auth";

function statusForMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes("not found") || normalized.includes("no longer exists")) return 404;
  if (normalized.includes("not configured")) return 503;
  if (
    normalized.includes("cannot") ||
    normalized.includes("requires") ||
    normalized.includes("must ") ||
    normalized.includes("already") ||
    normalized.includes("superseded") ||
    normalized.includes("exhausted") ||
    normalized.includes("current status") ||
    normalized.includes("state changed")
  ) return 409;
  return 500;
}

export function apiError(error: unknown) {
  console.error(error);
  if (error instanceof AuthenticationRequiredError || error instanceof OperatorUnauthorizedError) {
    return NextResponse.json({ error: "unauthorized", message: error.message }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof PermissionDeniedError || error instanceof CsrfValidationError) {
    return NextResponse.json({ error: "forbidden", message: error.message }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  if (error instanceof ZodError) {
    const validationError = error as ZodError;
    return NextResponse.json(
      { error: "validation_error", message: "Request validation failed", details: validationError.flatten() },
      { status: 400 },
    );
  }

  if (error instanceof Error) {
    const status = statusForMessage(error.message);
    const exposeMessage = status < 500 || process.env.NODE_ENV !== "production";
    return NextResponse.json(
      { error: status === 404 ? "not_found" : status === 409 ? "conflict" : "internal_error", message: exposeMessage ? error.message : "Request failed" },
      { status },
    );
  }

  return NextResponse.json({ error: "internal_error", message: "Request failed" }, { status: 500 });
}
