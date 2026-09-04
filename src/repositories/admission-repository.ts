import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { getDb, listCollectionIndexes } from "@/lib/mongodb";
import { currentTenantId, tenantFilter } from "@/lib/tenant-context";
import { lazyAsync } from "@/lib/lazy-async";
import { withMongoTransaction } from "@/lib/transactions";
import type { AdmissionReservation, UsageBucket } from "@/schemas/admission";
import type { ExecutionMode } from "@/schemas/execution";

const collections = lazyAsync(async () => {
  const db = await getDb();
  const reservations = db.collection<AdmissionReservation>("admission_reservations");
  const buckets = db.collection<UsageBucket>("usage_buckets");
  const indexes = await listCollectionIndexes(reservations);
  const legacyKey = indexes.find((index) => index.unique && index.key?.key === 1 && Object.keys(index.key).length === 1);
  if (legacyKey && legacyKey.name && legacyKey.name !== "_id_") await reservations.dropIndex(legacyKey.name).catch(() => undefined);
  await Promise.all([
    reservations.createIndex({ id: 1 }, { unique: true }),
    reservations.createIndex({ tenantId: 1, key: 1 }, { unique: true }),
    reservations.createIndex({ tenantId: 1, jobId: 1 }, { sparse: true }),
    reservations.createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
    buckets.createIndex({ id: 1 }, { unique: true }),
    buckets.createIndex({ tenantId: 1, day: 1 }, { unique: true }),
  ]);
  return { reservations, buckets };
});

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

export const admissionRepository = {
  async reserve(input: {
    key: string;
    runId: string;
    projectId: string;
    executionMode: ExecutionMode;
    units: number;
  }) {
    const { reservations, buckets } = await collections();
    return withMongoTransaction(async (session) => {
      const config = env();
      const tenantId = currentTenantId();
      const day = utcDay();
      const bucketId = `${tenantId}:${day}`;
      const now = new Date();
      const existing = await reservations.findOne({ tenantId, key: input.key }, { projection: { _id: 0 }, session });
      if (existing && existing.status !== "released") return existing;
      await buckets.updateOne(
        { id: bucketId },
        {
          $setOnInsert: {
            id: bucketId,
            tenantId,
            day,
            limitUnits: config.AGENCY_DAILY_EXECUTION_BUDGET_UNITS,
            reservedUnits: 0,
            consumedUnits: 0,
            releasedUnits: 0,
            createdAt: now,
          },
          $set: { updatedAt: now },
        },
        { upsert: true, session },
      );
      const bucket = await buckets.findOneAndUpdate(
        {
          id: bucketId,
          $expr: {
            $lte: [
              { $add: ["$reservedUnits", "$consumedUnits", input.units] },
              "$limitUnits",
            ],
          },
        },
        { $inc: { reservedUnits: input.units }, $set: { updatedAt: now } },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (!bucket) throw new Error("Daily execution budget is exhausted");

      if (existing?.status === "released") {
        const reactivated = await reservations.findOneAndUpdate(
          { id: existing.id, status: "released" },
          {
            $set: {
              status: "reserved",
              units: input.units,
              executionMode: input.executionMode,
              createdAt: now,
              updatedAt: now,
              settledAt: null,
              jobId: null,
            },
          },
          { returnDocument: "after", projection: { _id: 0 }, session },
        );
        if (!reactivated) throw new Error("Admission reservation changed while it was being reactivated");
        return reactivated;
      }

      const reservation: AdmissionReservation = {
        id: randomUUID(),
        tenantId,
        key: input.key,
        runId: input.runId,
        projectId: input.projectId,
        executionMode: input.executionMode,
        units: input.units,
        status: "reserved",
        jobId: null,
        createdAt: now,
        updatedAt: now,
        settledAt: null,
      };
      await reservations.insertOne(reservation, { session });
      return reservation;
    });
  },

  async attachJob(id: string, jobId: string) {
    const { reservations } = await collections();
    return reservations.findOneAndUpdate(
      tenantFilter({ id, status: "reserved", $or: [{ jobId: null }, { jobId }] }),
      { $set: { jobId, updatedAt: new Date() } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  },

  async settle(id: string, outcome: "consumed" | "released") {
    const { reservations, buckets } = await collections();
    return withMongoTransaction(async (session) => {
      const current = await reservations.findOne(tenantFilter({ id }), { projection: { _id: 0 }, session });
      if (!current || current.status !== "reserved") return current;
      const now = new Date();
      const day = current.createdAt.toISOString().slice(0, 10);
      const updated = await reservations.findOneAndUpdate(
        tenantFilter({ id, status: "reserved" }),
        { $set: { status: outcome, updatedAt: now, settledAt: now } },
        { returnDocument: "after", projection: { _id: 0 }, session },
      );
      if (!updated) return current;
      await buckets.updateOne(
        { id: `${current.tenantId}:${day}` },
        {
          $inc: outcome === "consumed"
            ? { reservedUnits: -current.units, consumedUnits: current.units }
            : { reservedUnits: -current.units, releasedUnits: current.units },
          $set: { updatedAt: now },
        },
        { session },
      );
      return updated;
    });
  },

  async currentSummary() {
    const { reservations, buckets } = await collections();
    const config = env();
    const tenantId = currentTenantId();
    const day = utcDay();
    const [bucket, reservedCount] = await Promise.all([
      buckets.findOne({ id: `${tenantId}:${day}` }, { projection: { _id: 0 } }),
      reservations.countDocuments({ tenantId, status: "reserved" }),
    ]);
    return {
      day,
      limitUnits: bucket?.limitUnits ?? config.AGENCY_DAILY_EXECUTION_BUDGET_UNITS,
      reservedUnits: bucket?.reservedUnits ?? 0,
      consumedUnits: bucket?.consumedUnits ?? 0,
      releasedUnits: bucket?.releasedUnits ?? 0,
      activeReservations: reservedCount,
    };
  },
};
