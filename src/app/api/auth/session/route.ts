import { NextResponse } from "next/server";
import { publicPrincipal, requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { tenantRepository } from "@/repositories/tenant-repository";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal(request, "control:read");
    const tenant = await tenantRepository.getCurrent();
    return NextResponse.json({ principal: publicPrincipal(principal), tenant }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
