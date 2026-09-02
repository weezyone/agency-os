import { NextResponse } from "next/server";
import { projectRepository } from "@/repositories/project-repository";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "control:read");
    const { id } = await context.params;
    const result = await projectRepository.getProject(id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
