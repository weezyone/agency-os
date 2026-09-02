import assert from "node:assert/strict";

const baseUrl = (process.env.AGENCY_STAGING_BASE_URL ?? "").replace(/\/$/, "");
const keyA = process.env.AGENCY_STAGING_API_KEY_A ?? "";
const keyB = process.env.AGENCY_STAGING_API_KEY_B ?? "";
const projectIdA = process.env.AGENCY_STAGING_PROJECT_ID_A ?? "";

if (!baseUrl || !keyA) {
  throw new Error("AGENCY_STAGING_BASE_URL and AGENCY_STAGING_API_KEY_A are required");
}

async function request(path: string, key?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: key ? { "x-agency-api-key": key } : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

const health = await request("/api/health");
assert.equal(health.response.status, 200, `public health failed: ${JSON.stringify(health.body)}`);
assert.equal((health.body as { status?: string }).status, "ok");
assert.equal((health.body as { version?: string }).version, "0.7.0");

const sessionA = await request("/api/auth/session", keyA);
assert.equal(sessionA.response.status, 200, `tenant A authentication failed: ${JSON.stringify(sessionA.body)}`);
const principalA = (sessionA.body as { principal: { tenantId: string } }).principal;
const tenantA = (sessionA.body as { tenant: { id: string } }).tenant;
assert.ok(principalA.tenantId);
assert.equal(tenantA.id, principalA.tenantId);

const projectsA = await request("/api/projects", keyA);
assert.equal(projectsA.response.status, 200, `tenant A project listing failed: ${JSON.stringify(projectsA.body)}`);
for (const project of (projectsA.body as { projects: Array<{ tenantId: string }> }).projects) {
  assert.equal(project.tenantId, principalA.tenantId, "tenant A received a foreign project");
}

const deep = await request("/api/health?deep=1", keyA);
assert.ok([200, 503].includes(deep.response.status), `deep health returned ${deep.response.status}`);
assert.ok(["ok", "degraded"].includes((deep.body as { status?: string }).status ?? ""));

if (keyB) {
  const sessionB = await request("/api/auth/session", keyB);
  assert.equal(sessionB.response.status, 200, `tenant B authentication failed: ${JSON.stringify(sessionB.body)}`);
  const principalB = (sessionB.body as { principal: { tenantId: string } }).principal;
  assert.notEqual(principalB.tenantId, principalA.tenantId, "acceptance keys must belong to different tenants");

  const projectsB = await request("/api/projects", keyB);
  assert.equal(projectsB.response.status, 200);
  for (const project of (projectsB.body as { projects: Array<{ tenantId: string }> }).projects) {
    assert.equal(project.tenantId, principalB.tenantId, "tenant B received a foreign project");
  }

  if (projectIdA) {
    const crossTenantRead = await request(`/api/projects/${encodeURIComponent(projectIdA)}`, keyB);
    assert.equal(crossTenantRead.response.status, 404, "tenant B could read tenant A project by identifier");
  }
}

console.log(JSON.stringify({
  status: "passed",
  baseUrl,
  tenantA: principalA.tenantId,
  crossTenantProbe: Boolean(keyB && projectIdA),
  checkedAt: new Date().toISOString(),
}, null, 2));
