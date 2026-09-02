import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/authorization";
import { apiError } from "@/lib/http";
import { usageRepository } from "@/repositories/usage-repository";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "usage:read");
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const runId = url.searchParams.get("runId") ?? undefined;
    const sinceDays = Math.min(Math.max(Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 3650);
    const [events, summary] = await Promise.all([
      usageRepository.list(limit, { projectId, runId }),
      usageRepository.summary(new Date(Date.now() - sinceDays * 86_400_000)),
    ]);
    return NextResponse.json({ events, summary });
  } catch (error) {
    return apiError(error);
  }
}
