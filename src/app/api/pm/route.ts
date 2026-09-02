import { NextResponse } from "next/server";
import { z } from "zod";
import { projectManagerAgent } from "@/mastra/agents/project-manager-agent";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { env } from "@/lib/env";
import { recordGenerationUsage } from "@/services/usage-service";

const bodySchema = z.object({
  message: z.string().min(1),
  projectId: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const principal = await requirePrincipal(request, "project:write");
    const body = bodySchema.parse(await request.json());
    const result = await projectManagerAgent.generate(body.message, {
      memory: {
        resource: `tenant:${principal.tenantId}:project:${body.projectId}`,
        thread: `tenant:${principal.tenantId}:pm:${body.projectId}:${principal.id}`,
      },
    });
    await recordGenerationUsage({
      result,
      model: env().AGENCY_MODEL,
      agent: "project-manager",
      operation: "pm.chat",
      requestId: result.runId ?? null,
      projectId: body.projectId,
    }).catch((error) => console.error("Usage accounting failed", error));
    return NextResponse.json({ text: result.text, runId: result.runId });
  } catch (error) {
    return apiError(error);
  }
}
