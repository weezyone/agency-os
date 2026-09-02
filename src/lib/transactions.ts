import type { ClientSession } from "mongodb";
import { env } from "@/lib/env";
import { getMongoClient } from "@/lib/mongodb";

function transactionUnsupported(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("transaction numbers are only allowed")
    || message.includes("does not support transactions")
    || message.includes("replica set")
    || message.includes("mongos");
}

/**
 * Runs multi-document control-plane changes atomically when MongoDB supports
 * transactions. Standalone development servers can opt into a documented
 * serial fallback; production may require transactions through configuration.
 */
export async function withMongoTransaction<T>(work: (session: ClientSession | undefined) => Promise<T>) {
  const client = await getMongoClient();
  const session = client.startSession();
  try {
    let value: T | undefined;
    await session.withTransaction(async () => {
      value = await work(session);
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    return value as T;
  } catch (error) {
    if (env().AGENCY_TRANSACTIONS_REQUIRED || !transactionUnsupported(error)) throw error;
    return work(undefined);
  } finally {
    await session.endSession();
  }
}
