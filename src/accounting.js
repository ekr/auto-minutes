/**
 * Token Usage & Cost Accounting
 * Accumulates token usage across API calls and prints a summary
 */

const PRICING = {
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

// Deepgram pay-as-you-go prerecorded pricing, USD per minute of audio.
// Diarization and keyterm boosting are included at no surcharge.
// Approximate list prices as of writing — verify against current Deepgram pricing.
const AUDIO_PRICING = {
  "deepgram:nova-3": { perMinute: 0.0052 },
  "deepgram:nova-2": { perMinute: 0.0043 },
};

const usageRecords = [];

/**
 * Record a usage entry from an API call
 * @param {{ inputTokens?: number, outputTokens?: number, model: string, audioSeconds?: number }} usage
 */
export function recordUsage(usage) {
  if (usage) {
    usageRecords.push(usage);
  }
}

/**
 * Aggregate recorded usage into per-model rows with cost estimates.
 * Pure function of the given records — does not read module state — so it's
 * unit-testable without capturing console output.
 * @param {Array<{ inputTokens?: number, outputTokens?: number, model: string, audioSeconds?: number }>} records
 * @returns {{ rows: Array<Object>, totalCost: number, allKnown: boolean }}
 */
export function computeCostSummary(records) {
  const tokenByModel = new Map();
  const audioByModel = new Map();

  for (const rec of records) {
    const key = rec.model || "unknown";
    if (rec.audioSeconds > 0) {
      if (!audioByModel.has(key)) {
        audioByModel.set(key, { audioSeconds: 0 });
      }
      audioByModel.get(key).audioSeconds += rec.audioSeconds || 0;
    } else {
      if (!tokenByModel.has(key)) {
        tokenByModel.set(key, { inputTokens: 0, outputTokens: 0 });
      }
      const agg = tokenByModel.get(key);
      agg.inputTokens += rec.inputTokens || 0;
      agg.outputTokens += rec.outputTokens || 0;
    }
  }

  const rows = [];
  let totalCost = 0;
  let allKnown = true;

  for (const [model, agg] of tokenByModel) {
    const pricing = PRICING[model];
    let cost = 0;
    let costKnown = false;
    if (pricing) {
      cost =
        (agg.inputTokens / 1_000_000) * pricing.input +
        (agg.outputTokens / 1_000_000) * pricing.output;
      costKnown = true;
      totalCost += cost;
    } else {
      allKnown = false;
    }
    rows.push({ model, kind: "tokens", inputTokens: agg.inputTokens, outputTokens: agg.outputTokens, cost, costKnown });
  }

  for (const [model, agg] of audioByModel) {
    const pricing = AUDIO_PRICING[model];
    const audioMinutes = (agg.audioSeconds || 0) / 60;
    let cost = 0;
    let costKnown = false;
    if (pricing) {
      cost = audioMinutes * pricing.perMinute;
      costKnown = true;
      totalCost += cost;
    } else {
      allKnown = false;
    }
    rows.push({ model, kind: "audio", audioMinutes, cost, costKnown });
  }

  return { rows, totalCost, allKnown };
}

/**
 * Print a summary table of token usage and estimated costs
 */
export function printSummary() {
  if (usageRecords.length === 0) {
    return;
  }

  const { rows, totalCost, allKnown } = computeCostSummary(usageRecords);
  const tokenRows = rows.filter((r) => r.kind === "tokens");
  const audioRows = rows.filter((r) => r.kind === "audio");

  const fmt = (n) => n.toLocaleString("en-US");

  let totalInput = 0;
  let totalOutput = 0;

  if (tokenRows.length > 0) {
    console.log("\n=== Token Usage & Cost ===");
    console.log(
      `${"Model".padEnd(28)} ${"Input Tokens".padStart(14)} ${"Output Tokens".padStart(14)} ${"Est. Cost".padStart(10)}`,
    );

    for (const row of tokenRows) {
      totalInput += row.inputTokens;
      totalOutput += row.outputTokens;
      const costStr = row.costKnown ? `$${row.cost.toFixed(2)}` : "unknown";
      console.log(
        `${row.model.padEnd(28)} ${fmt(row.inputTokens).padStart(14)} ${fmt(row.outputTokens).padStart(14)} ${costStr.padStart(10)}`,
      );
    }
  }

  if (audioRows.length > 0) {
    console.log("\n=== Audio Transcription (STT) ===");
    console.log(
      `${"Model".padEnd(28)} ${"Audio (min)".padStart(14)} ${"Est. Cost".padStart(10)}`,
    );

    for (const row of audioRows) {
      const costStr = row.costKnown ? `$${row.cost.toFixed(2)}` : "unknown";
      console.log(
        `${row.model.padEnd(28)} ${row.audioMinutes.toFixed(1).padStart(14)} ${costStr.padStart(10)}`,
      );
    }
  }

  console.log(
    `${"".padEnd(28)} ${"───────".padStart(14)} ${"───────".padStart(14)} ${"──────".padStart(10)}`,
  );
  const totalCostStr = allKnown ? `$${totalCost.toFixed(2)}` : `~$${totalCost.toFixed(2)}`;
  console.log(
    `${"Total".padEnd(28)} ${fmt(totalInput).padStart(14)} ${fmt(totalOutput).padStart(14)} ${totalCostStr.padStart(10)}`,
  );
}
