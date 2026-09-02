import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { prometheusMetrics } from "@/services/metrics-service";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "metrics:read");
    return new Response(await prometheusMetrics(), {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
