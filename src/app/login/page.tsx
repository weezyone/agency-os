export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const tenant = typeof params.tenant === "string" ? params.tenant : "";
  const returnTo = typeof params.returnTo === "string" ? params.returnTo : "/";
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <p className="eyebrow">AgencyOS</p>
        <h1>Sign in to your agency</h1>
        <p>Enter the tenant slug your agency administrator provided.</p>
        <form action="/api/auth/oidc/start" method="get">
          <label htmlFor="tenant">Tenant slug</label>
          <input id="tenant" name="tenant" required defaultValue={tenant} placeholder="paul-weezy-design" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit">Continue with SSO</button>
        </form>
      </section>
    </main>
  );
}
