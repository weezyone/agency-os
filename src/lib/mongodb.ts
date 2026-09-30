import { MongoClient, type Collection, type Document } from "mongodb";
import { env } from "@/lib/env";

const globalForMongo = globalThis as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

/**
 * Returns the shared MongoClient, connecting on first call. The promise is
 * cached on `globalThis` so Next.js dev hot-reloads reuse one connection pool
 * instead of leaking clients per module instance. A failed connection clears
 * the cache so the next call retries.
 */
export function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const client = new MongoClient(env().MONGODB_URI, {
      appName: "agency-os",
      maxPoolSize: 20,
      minPoolSize: 1,
      retryWrites: true,
    });
    const connection = client.connect().catch((error) => {
      delete globalForMongo.mongoClientPromise;
      throw error;
    });
    globalForMongo.mongoClientPromise = connection;
  }
  return globalForMongo.mongoClientPromise!;
}

/**
 * Returns the configured application database on the shared client.
 *
 * @throws {Error} When the client cannot connect.
 */
export async function getDb() {
  const client = await getMongoClient();
  return client.db(env().MONGODB_DATABASE);
}

/**
 * Checks whether an error is MongoDB code 26 (NamespaceNotFound), raised when
 * operating on a collection that does not exist yet.
 *
 * @param error - Caught error to classify.
 */
export function isMongoNamespaceNotFound(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === 26;
}

/**
 * Lists a collection's indexes, returning an empty array when the collection
 * has never been created instead of throwing NamespaceNotFound.
 *
 * @param collection - Collection whose indexes should be listed.
 */
export async function listCollectionIndexes<TSchema extends Document>(
  collection: Collection<TSchema>,
) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (isMongoNamespaceNotFound(error)) return [];
    throw error;
  }
}
