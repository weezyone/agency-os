export const dynamic = "force-dynamic";

import { tenantRepository } from "@/repositories/tenant-repository";

export default async function InvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const invitation = token ? await tenantRepository.verifyInvitation(token) : null;
  const tenant = invitation ? await tenantRepository.getActiveById(invitation.tenantId) : null;
  if (!invitation || !tenant) {
    return <main className="auth-shell"><section className="auth-card"><h1>Invitation unavailable</h1><p>The invitation is invalid, expired, revoked, or already used.</p></section></main>;
  }
  const href = `/api/auth/oidc/start?tenant=${encodeURIComponent(tenant.slug)}&invitation=${encodeURIComponent(token)}&returnTo=/`;
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">AgencyOS invitation</p>
        <h1>Join {tenant.displayName}</h1>
        <p>Continue through the agency identity provider as {invitation.email}.</p>
        <a className="button-link" href={href}>Accept invitation with SSO</a>
      </section>
    </main>
  );
}
