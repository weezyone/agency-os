import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { updateMember } from "@/services/identity-service";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "admin:members");
    const { id } = await context.params;
    const member = await updateMember(id, await request.json());
    return NextResponse.json({ member });
  } catch (error) {
    return apiError(error);
  }
}
