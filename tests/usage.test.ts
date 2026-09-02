import { describe, expect, it } from "vitest";
import { estimateUsageCostMicros, extractTokenUsage } from "@/services/usage-service";

describe("provider usage accounting", () => {
  it("normalizes current and legacy token field names", () => {
    expect(extractTokenUsage({ usage: {
      promptTokens: 1_000,
      completionTokens: 250,
      cacheReadInputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1_300,
    } })).toEqual({
      inputTokens: 1_000,
      outputTokens: 250,
      cachedInputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1_300,
    });
  });

  it("calculates cost only from the supplied tenant price catalog", () => {
    const micros = estimateUsageCostMicros({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 250_000,
      reasoningTokens: 100_000,
      totalTokens: 1_600_000,
    }, {
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 8_000_000,
      cachedInputMicrosPerMillion: 500_000,
      reasoningMicrosPerMillion: 1_000_000,
    });

    expect(micros).toBe(5_725_000);
  });
});
