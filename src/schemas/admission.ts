import { z } from "zod";

export const admissionReservationStatusSchema = z.enum(["reserved", "consumed", "released"]);

export const admissionReservationSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  key: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  executionMode: z.enum(["artifact", "workspace"]),
  units: z.number().int().positive(),
  status: admissionReservationStatusSchema,
  jobId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  settledAt: z.date().nullable(),
});

export const usageBucketSchema = z.object({
  id: z.string(),
  tenantId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limitUnits: z.number().int().positive(),
  reservedUnits: z.number().int().nonnegative(),
  consumedUnits: z.number().int().nonnegative(),
  releasedUnits: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AdmissionReservation = z.infer<typeof admissionReservationSchema>;
export type UsageBucket = z.infer<typeof usageBucketSchema>;
