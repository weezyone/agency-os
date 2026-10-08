import { linearIntegrationConfig } from "@/services/integration-secret-service";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

type GraphQLError = { message?: string };
type LinearResponse<T> = { data?: T; errors?: GraphQLError[] };

/**
 * Executes a Linear GraphQL operation with the current tenant's resolved
 * credential (OAuth bearer or raw API key).
 *
 * @param query - GraphQL document.
 * @param variables - Variables for the document.
 * @returns The `data` payload, typed by the caller.
 * @throws {Error} On non-2xx HTTP, any GraphQL errors, or a missing data payload.
 */
export async function linearGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const config = await linearIntegrationConfig();

  const response = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.authMode === "oauth"
        ? `Bearer ${config.token}`
        : config.token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
  const body = (await response.json()) as LinearResponse<T>;
  if (body.errors?.length) throw new Error(`Linear GraphQL: ${body.errors.map((error) => error.message ?? "unknown error").join("; ")}`);
  if (!body.data) throw new Error("Linear returned no data");
  return body.data;
}
