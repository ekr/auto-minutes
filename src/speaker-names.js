/**
 * Speaker name resolution helpers.
 * Shared between the standalone transcribe-diarize.js CLI and the main
 * pipeline's chirp+gemini name-fill hybrid (src/transcriber.js).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Helper to perform retries with exponential backoff
 */
async function retryWithBackoff(fn, retries = 3, delay = 5000, backoffFactor = 2) {
  let currentDelay = delay;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[Retry] Attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt === retries) {
        throw error;
      }
      console.log(`[Retry] Waiting ${currentDelay / 1000}s before retrying...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= backoffFactor;
    }
  }
}

/**
 * Extract JSON block from a string
 */
export function extractJSON(text) {
  // Try markdown block first
  const mdJsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (mdJsonMatch) {
    return JSON.parse(mdJsonMatch[1].trim());
  }

  const mdMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (mdMatch) {
    return JSON.parse(mdMatch[1].trim());
  }

  // Find braces
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not find any JSON braces in LLM response");
  }
  const jsonText = text.substring(start, end + 1);
  return JSON.parse(jsonText);
}

/**
 * Query Gemini to map generic speaker labels to actual names.
 * `file` may be null for a text-only request (no audio uploaded to Gemini).
 * When `usageAccumulator` is provided, token usage from the request(s) is
 * added to it in place (optional — existing callers that omit it are unaffected).
 */
export async function getSpeakerMapFromGemini(apiKey, modelName, file, transcript, participantsList, verbose = false, usageAccumulator = null) {
  const genAI = new GoogleGenerativeAI(apiKey);
  // We use low thinking level for deterministic schema-based outputs
  const genModel = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" }
    }
  });

  let prompt = `You are an expert meeting transcription assistant. You are provided with:
1. A transcription of a meeting containing generic speaker labels like "Speaker 1", "Speaker 2", etc.
`;

  if (participantsList) {
    prompt += `
2. A list of expected participants in the meeting:
${participantsList}
`;
  }

  prompt += `
Your task is to identify the actual name of each speaker (e.g. mapping "Speaker 1" to "John Doe").
- Analyze the speaker introductions, how people refer to each other, the topics discussed, and cross-reference them with the list of expected participants (if provided).
- Output ONLY a JSON object mapping each generic speaker label (exactly as written in the transcript, like "Speaker 1") to their identified real name.
- If a speaker's name cannot be identified, map them to a descriptive role (e.g. "Presenter", "Chairperson") or leave them as the original speaker label.
- Return ONLY the JSON object.

Example output format:
{
  "Speaker 1": "John Doe",
  "Speaker 2": "Jane Smith"
}
`;

  function recordUsage(response) {
    if (!usageAccumulator) return;
    const usageMeta = response?.usageMetadata;
    if (!usageMeta) return;
    usageAccumulator.inputTokens = (usageAccumulator.inputTokens || 0) + (usageMeta.promptTokenCount || 0);
    usageAccumulator.outputTokens = (usageAccumulator.outputTokens || 0) + (usageMeta.candidatesTokenCount || 0);
  }

  return retryWithBackoff(async () => {
    const contents = [];
    if (file) {
      contents.push({
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      });
    }
    contents.push({ text: prompt + `\n\nHere is the transcript:\n${transcript}` });

    if (verbose) console.log(`Sending content generation request to Gemini (${modelName})...`);
    const result = await genModel.generateContent(contents);
    const responseText = result.response.text();
    recordUsage(result.response);

    if (verbose) console.log("Gemini raw response:\n", responseText);

    try {
      return extractJSON(responseText);
    } catch (parseError) {
      console.warn(`JSON Parse failed on primary attempt: ${parseError.message}`);

      // Fallback: request without JSON config constraint or with shepherding
      const fallbackModel = genAI.getGenerativeModel({ model: modelName });
      const correctionPrompt = `The previous response was not valid JSON. Extract the speaker mapping to a clean JSON object. Do not output anything but the JSON block. Here is the transcript:\n${transcript}`;

      const contentsFallback = [];
      if (file) {
        contentsFallback.push({
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri,
          },
        });
      }
      contentsFallback.push({ text: correctionPrompt });

      const resultFallback = await fallbackModel.generateContent(contentsFallback);
      const responseTextFallback = resultFallback.response.text();
      recordUsage(resultFallback.response);
      return extractJSON(responseTextFallback);
    }
  }, 3, 5000);
}

/**
 * Normalizes speaker map keys to ensure matchability (e.g. "1" -> "Speaker 1")
 */
export function normalizeSpeakerMap(speakerMap) {
  const normalized = {};
  for (const [key, value] of Object.entries(speakerMap)) {
    let normalizedKey = key.trim();
    if (/^\d+$/.test(normalizedKey)) {
      normalizedKey = `Speaker ${normalizedKey}`;
    }
    normalizedKey = normalizedKey.replace(/\*\*/g, '');
    normalized[normalizedKey] = value.trim();
  }
  return normalized;
}

/**
 * Replace generic speaker labels in the transcript with their names.
 * Only the label itself is replaced (via regex anchored on "Speaker N:"),
 * so any leading text on the line — e.g. a "[HH:MM:SS] " timestamp prefix
 * added by the chirp formatter — is preserved untouched.
 */
export function applySpeakerMap(rawTranscript, speakerMap) {
  let processed = rawTranscript;
  for (const [label, name] of Object.entries(speakerMap)) {
    const escapedLabel = label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    // Matches "**Speaker 1**:", "**Speaker 1** :", "Speaker 1:", "Speaker 1 :"
    const regex = new RegExp(`(?:\\*\\*)?${escapedLabel}(?:\\*\\*)?\\s*:`, 'g');
    processed = processed.replace(regex, `**${name}**:`);
  }

  return processed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n\n') + '\n';
}

/**
 * Format a duration in seconds as "HH:MM:SS"
 */
export function formatOffset(seconds) {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Parse a Google STT v2 REST offset value into seconds.
 * Accepts a string like "12.340s", a plain number of seconds, or a
 * {seconds, nanos} duration object. Returns null (never NaN) if unparseable.
 */
export function parseOffset(raw) {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }

  if (typeof raw === "string") {
    const match = raw.match(/^(-?[\d.]+)s?$/);
    if (!match) return null;
    const value = parseFloat(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  if (typeof raw === "object") {
    const seconds = Number(raw.seconds ?? 0);
    const nanos = Number(raw.nanos ?? 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return seconds + nanos / 1e9;
  }

  return null;
}
