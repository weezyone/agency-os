import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { requirePrincipal } from "@/lib/authorization";
import { readArtifact } from "@/services/artifact-service";

function safeFilename(filename: string) {
  return filename.replace(/[\r\n"\\/]+/g, "-").slice(0, 160) || "artifact.bin";
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePrincipal(request, "artifact:read");
    const { id } = await context.params;
    const result = await readArtifact(id);
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(result.content), {
      status: 200,
      headers: {
        "content-type": result.artifact.contentType,
        "content-length": String(result.content.length),
        "content-disposition": `attachment; filename="${safeFilename(result.artifact.filename)}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        etag: `"${result.artifact.sha256}"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
