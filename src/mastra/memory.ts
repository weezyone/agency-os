import { Memory } from "@mastra/memory";
import { MongoDBStore } from "@mastra/mongodb";
import { env } from "@/lib/env";

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
