import { Memory } from "@mastra/memory";
import { MongoDBStore } from "@mastra/mongodb";
import { env } from "@/lib/env";

/**
 * Shared agent memory for AgencyOS, persisted in MongoDB with an observational
 * memory model. Callers scope it per tenant by passing tenant-prefixed
 * resource/thread keys (e.g. `tenant:{tenantId}:project:{projectId}`) on each
 * agent call.
 */
export const agencyMemory = new Memory({
  storage: new MongoDBStore({
    id: "agency-os-mongodb-storage",
    uri: env().MONGODB_URI,
    dbName: env().MONGODB_DATABASE,
  }),
  options: {
    observationalMemory: {
      model: env().AGENCY_MEMORY_MODEL,
    },
  },
});
