import { describe, expect, it } from "vitest";
import { intakeRequestSchema, intakeAnalysisSchema } from "@/schemas/intake";
import { planningOutputSchema } from "@/schemas/planning";

describe("agency contracts", () => {
  it("accepts a valid client intake", () => {
    expect(intakeRequestSchema.parse({
      companyName: "Example Co",
      contactName: "Jane Example",
      email: "jane@example.com",
      projectTitle: "Website rebuild",
      projectBrief: "Replace the current marketing site with a conversion-focused experience.",
      goals: ["Increase qualified leads"],
    }).companyName).toBe("Example Co");
  });

  it("rejects an empty planning output", () => {
    expect(() => planningOutputSchema.parse({ phases: [], tasks: [], immediateNextAction: "" })).toThrow();
  });

  it("requires intake risks and open questions to be explicit arrays", () => {
    expect(() => intakeAnalysisSchema.parse({ projectType: "site" })).toThrow();
  });
});
