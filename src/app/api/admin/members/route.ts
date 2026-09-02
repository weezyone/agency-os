import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { createMember, listMembers } from "@/services/identity-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:members");
    return NextResponse.json({ members: await listMembers() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:members");
    const member = await createMember(await request.json(), principal);
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
