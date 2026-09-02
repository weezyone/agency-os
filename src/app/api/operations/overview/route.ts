import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { operationsSnapshot } from "@/services/metrics-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "metrics:read");
    return NextResponse.json(await operationsSnapshot({ probeArtifactStore: true }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
