import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { revokeApiKey } from "@/services/identity-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "admin:keys");
    const { id } = await context.params;
    return NextResponse.json({ key: await revokeApiKey(id) });
  } catch (error) {
    return apiError(error);
  }
}
