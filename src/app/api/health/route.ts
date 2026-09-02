import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";
import { env } from "@/lib/env";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { getDb } from "@/lib/mongodb";
import { operationsSnapshot } from "@/services/metrics-service";
import { workspaceProcessProvider } from "@/workspaces/provider";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const checkedAt = new Date();
  try {
    const deep = new URL(request.url).searchParams.get("deep") === "1";
    if (!deep) {
      return NextResponse.json({ status: "ok", version: packageJson.version, checkedAt }, {
        headers: { "cache-control": "no-store" },
      });
    }

    await requirePrincipal(request, "metrics:read");
    const db = await getDb();
    await db.command({ ping: 1 });
    const [operations, sandbox] = await Promise.all([
      operationsSnapshot({ probeArtifactStore: true }),
      workspaceProcessProvider().health?.() ?? Promise.resolve({
        provider: workspaceProcessProvider().name,
        available: null,
        version: null,
        image: env().AGENCY_SANDBOX_IMAGE,
        message: "Configured provider does not expose a health probe",
      }),
    ]);

    const waitingWork = operations.jobs.ready + operations.outbox.pending + operations.outbox.retryWait;
    const degraded = (waitingWork > 0 && operations.runners.online === 0)
      || operations.storage.available === false
      || sandbox.available === false;

    return NextResponse.json({
      status: degraded ? "degraded" : "ok",
      version: packageJson.version,
      checkedAt,
      mongodb: "ok",
      operations,
      sandbox,
    }, {
      status: degraded ? 503 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
