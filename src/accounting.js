/**
 * Token Usage & Cost Accounting
 * Accumulates token usage across API calls and prints a summary
 */

const PRICING = {
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-3-flash-preview": { input: 0.15, output: 0.6 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

const usageRecords = [];

/**
 * Record a usage entry from an API call
 * @param {{ inputTokens: number, outputTokens: number, model: string }} usage
 */
export function recordUsage(usage) {
  if (usage) {
    usageRecords.push(usage);
  }
}

/**
 * Print a summary table of token usage and estimated costs
 */
export function printSummary() {
  if (usageRecords.length === 0) {
    return;
  }

  // Aggregate by model
  const byModel = new Map();
  for (const rec of usageRecords) {
    const key = rec.model || "unknown";
    if (!byModel.has(key)) {
      byModel.set(key, { inputTokens: 0, outputTokens: 0 });
    }
    const agg = byModel.get(key);
    agg.inputTokens += rec.inputTokens || 0;
    agg.outputTokens += rec.outputTokens || 0;
  }

  const fmt = (n) => n.toLocaleString("en-US");

  console.log("\n=== Token Usage & Cost ===");
  console.log(
    `${"Model".padEnd(28)} ${"Input Tokens".padStart(14)} ${"Output Tokens".padStart(14)} ${"Est. Cost".padStart(10)}`,
  );

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let allKnown = true;

  for (const [model, agg] of byModel) {
    totalInput += agg.inputTokens;
    totalOutput += agg.outputTokens;

    const pricing = PRICING[model];
    let costStr;
    if (pricing) {
      const cost =
        (agg.inputTokens / 1_000_000) * pricing.input +
        (agg.outputTokens / 1_000_000) * pricing.output;
      totalCost += cost;
      costStr = `$${cost.toFixed(2)}`;
    } else {
      allKnown = false;
      costStr = "unknown";
    }

    console.log(
      `${model.padEnd(28)} ${fmt(agg.inputTokens).padStart(14)} ${fmt(agg.outputTokens).padStart(14)} ${costStr.padStart(10)}`,
    );
  }

  if (byModel.size > 1 || true) {
    console.log(
      `${"".padEnd(28)} ${"───────".padStart(14)} ${"───────".padStart(14)} ${"──────".padStart(10)}`,
    );
    const totalCostStr = allKnown
      ? `$${totalCost.toFixed(2)}`
      : `~$${totalCost.toFixed(2)}`;
    console.log(
      `${"Total".padEnd(28)} ${fmt(totalInput).padStart(14)} ${fmt(totalOutput).padStart(14)} ${totalCostStr.padStart(10)}`,
    );
  }
}
