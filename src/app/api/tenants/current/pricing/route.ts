import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { usageRepository } from "@/repositories/usage-repository";
import { configurePrice } from "@/services/usage-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:pricing");
    return NextResponse.json({ prices: await usageRepository.listPrices() });
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:pricing");
    const price = await configurePrice(await request.json(), principal);
    return NextResponse.json({ price }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
