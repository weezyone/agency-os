import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { usageRepository } from "@/repositories/usage-repository";
import { configurePrice } from "@/services/usage-service";

/**
 * Price-catalog management for the caller's tenant: unit prices used for usage
 * accounting and cost rollups.
 */

/** List configured prices. Requires `admin:pricing`. */
export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "admin:pricing");
    return NextResponse.json({ prices: await usageRepository.listPrices() });
  } catch (error) {
    return apiError(error);
  }
}

/** Configure a price entry. Requires `admin:pricing`; returns 201. */
export async function PUT(request: Request) {
  try {
    const principal = await requirePrincipal(request, "admin:pricing");
    const price = await configurePrice(await request.json(), principal);
    return NextResponse.json({ price }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
