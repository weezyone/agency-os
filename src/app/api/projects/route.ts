import { NextResponse } from "next/server";
import { projectRepository } from "@/repositories/project-repository";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";

export async function GET(request: Request) {
  try {
    await requirePrincipal(request, "control:read");
    const projects = await projectRepository.listProjects();
    return NextResponse.json({ projects }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
