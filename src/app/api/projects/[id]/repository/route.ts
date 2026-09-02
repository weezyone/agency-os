import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { principalActor, requirePrincipal } from "@/lib/authorization";
import { projectRepository } from "@/repositories/project-repository";
import { bindRepositorySchema } from "@/schemas/workspace";
import {
  assertRepositoryAllowed,
  inferGitHubFullName,
  normalizeRepositoryCloneUrl,
} from "@/services/workspace-policy";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requirePrincipal(request, "project:write");
    const { id } = await context.params;
    const input = bindRepositorySchema.parse(await request.json());
    const cloneUrl = input.cloneUrl
      ? normalizeRepositoryCloneUrl(input.cloneUrl)
      : input.provider === "github"
        ? normalizeRepositoryCloneUrl(input.url)
        : input.url;
    assertRepositoryAllowed(cloneUrl);
    const project = await projectRepository.bindRepository(id, {
      provider: input.provider,
      url: input.url,
      cloneUrl,
      fullName: input.fullName ?? (input.provider === "github" ? inferGitHubFullName(input.url) : null),
      defaultBranch: input.defaultBranch,
      externalId: input.externalId ?? null,
      boundBy: principalActor(principal),
      boundAt: new Date(),
    });
    if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    return apiError(error);
  }
}
