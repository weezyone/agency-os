import { MongoClient, type Collection, type Document } from "mongodb";
import { env } from "@/lib/env";

const globalForMongo = globalThis as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

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

export async function getDb() {
  const client = await getMongoClient();
  return client.db(env().MONGODB_DATABASE);
}

export function isMongoNamespaceNotFound(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code: unknown }).code === 26;
}

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
