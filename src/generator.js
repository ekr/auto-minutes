/**
 * Minutes Generator using Claude or Gemini API
 * Converts transcripts into structured meeting minutes
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { sanitizeSessionName } from "./publisher.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
let generationTimeoutMs = DEFAULT_TIMEOUT_MS;

/**
 * Set the generation timeout
 * @param {number} ms - Timeout in milliseconds
 */
export function setGenerationTimeout(ms) {
  generationTimeoutMs = ms;
}

/**
 * Race a promise against the generation timeout, clearing the timer afterward.
 */
function withTimeout(promise, sessionName) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM generation timed out after ${generationTimeoutMs / 1000}s for session: ${sessionName}`)), generationTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let anthropic = null;
let gemini = null;
let currentModel = null;

/**
 * Initialize the Claude API client
 * @param {string} apiKey - Anthropic API key
 */
export function initializeClaude(apiKey) {
  anthropic = new Anthropic({ apiKey });
  currentModel = "claude";
}

/**
 * Initialize the Gemini API client
 * @param {string} apiKey - Google API key
 */
export function initializeGemini(apiKey) {
  gemini = new GoogleGenerativeAI(apiKey);
  currentModel = "gemini";
}

/**
 * Build the context sections to inject into the LLM prompt.
 * @param {Object|null} context - Pre-fetched session context
 * @param {string} sessionName - Name of the session
 * @returns {string} Concatenated context string ready to embed in the prompt
 */
export function buildContextPrompt(context, sessionName) {
  const { slidesAndBluesheet = null, wgDocuments = [] } = context || {};
  let result = '';

  // Working group documents
  if (wgDocuments.length > 0) {
    // Filter to active drafts only, limit to 10 to keep the prompt manageable
    const activeDrafts = wgDocuments.filter(doc =>
      doc.Name && doc.Name.startsWith('draft-ietf-') &&
      (doc['Status in the IETF process'] === 'I-D Exists' ||
       doc['Status in the IETF process'] === 'Active' ||
       doc['Status in the IETF process'].includes('WG'))
    ).slice(0, 100);

    if (activeDrafts.length > 0) {
      result += `\n\nWorking Group Documents Context:\nThe following active drafts are associated with the ${sessionName} working group:\n`;
      activeDrafts.forEach(doc => {
        if (doc.Name && doc.Title && doc['Status in the IETF process']) {
          result += `- ${doc.Name}: ${doc.Title} (${doc['Status in the IETF process']})\n`;
        }
      });
      result += '\nWhen referencing drafts in the minutes, use the exact draft names from this list.\n';
    }
  }

  if (slidesAndBluesheet) {
    // Slides
    if (slidesAndBluesheet.slides && slidesAndBluesheet.slides.length > 0) {
      result += `\n\nSession Slides:\n`;
      slidesAndBluesheet.slides.forEach((slide, index) => {
        result += `${index + 1}. ${slide.title}: ${slide.url}\n`;
      });
      result += `\nWhen referencing specific presentations, use the slide titles and include the link to the slide deck.\n`;
    }

    // Bluesheet participant names.
    //
    // Actual bluesheet format (e.g. bluesheets-124-privacypass-*.txt):
    //   Bluesheet for IETF-NNN: <group>  <day-time>
    //   ================================================================
    //   N attendees.     ← "attendees" keyword triggers name collection
    //
    //   First Last<TAB>Affiliation
    //   ...
    //
    // NOTE: all external inputs (names, slide titles, bluesheet text) are embedded
    // verbatim in the LLM prompt. Names are listed as a comma-separated data block
    // to limit prompt injection risk, though the same risk applies to all inputs.
    if (slidesAndBluesheet.bluesheet) {
      const lines = slidesAndBluesheet.bluesheet.split('\n');
      const participants = new Set();
      const startIdx = lines.findIndex(l => /\battendees\b/i.test(l));

      for (const line of startIdx >= 0 ? lines.slice(startIdx + 1) : []) {
        const trimmed = line.trim();
        if (/^[-=]{3,}/.test(trimmed)) break; // safety net for variant formats
        if (!trimmed) continue;
        const name = trimmed.split(/\t| {2,}/)[0].trim();
        if (name.length > 2) participants.add(name);
      }

      if (participants.size > 0) {
        const participantList = Array.from(participants).slice(0, 1000);
        result += `\n\nMeeting Participants (${participants.size} attendees):\n`;
        for (let i = 0; i < participantList.length; i += 5) {
          result += participantList.slice(i, i + 5).join(', ') + '\n';
        }
        result += '\nUse these participant names when attributing statements in the minutes.\n';
      }
    }
  }

  return result;
}

/**
 * Generate meeting minutes from a transcript using the configured model
 * @param {string} transcript - The meeting transcript text (JSON format)
 * @param {string} sessionName - Name of the session
 * @param {boolean} verbose - Whether to log verbose status information
 * @param {string} modelName - Full model name to use (e.g., "gemini-3-flash", "claude-sonnet-4-6")
 * @param {Object} context - Pre-fetched session context (optional)
 * @param {Object} context.slidesAndBluesheet - Slides and bluesheet data from fetchSessionSlidesAndBluesheet
 * @param {Array}  context.wgDocuments - Working group documents from fetchWorkingGroupDocuments
 * @returns {Promise<string>} Generated minutes in Markdown format
 */
export async function generateMinutes(transcript, sessionName, verbose = false, modelName = null, context = null) {
  const sanitizedName = sanitizeSessionName(sessionName);
  const wgLink = `../wg/${sanitizedName}.html`;

  const contextBlock = buildContextPrompt(context, sessionName);

  const prompt = `You are an expert technical writer for the IETF. Convert the following meeting transcript into well-structured meeting minutes in Markdown format. It should contain an account of the discussion including any decisions made.

Session: ${sessionName}${contextBlock}

Requirements:
- Start with a # header linking to the WG page: # [${sessionName}](${wgLink})
- Include a ## Summary section with a brief overview
- Include a ## Key Discussion Points section with bullet points
- Include a ## Decisions and Action Items section if applicable
- Include a ## Next Steps section if applicable
- Be concise but capture all important technical discussions
- Use proper Markdown formatting
- Focus on technical content and decisions
- When drafts or specifications are discussed, include their full draft names (e.g., draft-ietf-foo-bar) in addition to any acronyms used
- When referencing presentations or slides, use the slide titles provided and include links to the specific slide decks
- Use participant names from the provided list when attributing statements or discussions; the bluesheet is authoritative for names while the transcript may contain errors, so use the bluesheet to correct any names found in the transcript
- Remember that IETF participants are individuals, not representatives of companies or other entities
- Remember that consensus is not judged in IETF meetings; it is established separately. It's OK to say things like "a poll of the room was taken" or "a sense of those present indicates..."

The transcript is in JSON format with timestamps and text. Here is the transcript:

${transcript}

Generate the meeting minutes:`;

  if (verbose) {
    console.log(`    [LLM] Model: ${modelName || currentModel}`);
    console.log(`    [LLM] Transcript: ${transcript.length} chars, Prompt: ${prompt.length} chars`);
    console.log(`    [LLM] Sending API request...`);
  }

  const startTime = Date.now();
  let generatedText;

  if (currentModel === "claude") {
    if (!anthropic) {
      throw new Error(
        "Claude API not initialized. Call initializeClaude() first.",
      );
    }

    const message = await withTimeout(
      anthropic.messages.create({
        model: modelName || "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      sessionName,
    );

    generatedText = message.content[0].text;

    if (verbose) {
      console.log(`    [LLM] Tokens: ${message.usage.input_tokens} in, ${message.usage.output_tokens} out`);
    }
  } else if (currentModel === "gemini") {
    if (!gemini) {
      throw new Error(
        "Gemini API not initialized. Call initializeGemini() first.",
      );
    }

    const model = gemini.getGenerativeModel({ model: modelName || "gemini-3.1-pro-preview" });
    const result = await withTimeout(model.generateContent(prompt), sessionName);
    const response = result.response;
    generatedText = response.text();

    if (verbose) {
      const usage = response.usageMetadata;
      if (usage) {
        console.log(`    [LLM] Tokens: ${usage.promptTokenCount || 'N/A'} in, ${usage.candidatesTokenCount || 'N/A'} out`);
      }
    }
  } else {
    throw new Error(
      "No model initialized. Call initializeClaude() or initializeGemini() first.",
    );
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (verbose) {
    console.log(`    [LLM] Completed in ${duration}s, generated ${generatedText.length} chars`);
  }

  return cleanMarkdownCodeFence(generatedText);
}

/**
 * Remove markdown code fence markers that some LLMs add around their output
 * @param {string} text - The text to clean
 * @returns {string} Cleaned text without code fence markers
 */
function cleanMarkdownCodeFence(text) {
  // Remove ```markdown at the start and ``` at the end
  let cleaned = text.trim();

  // Check for opening fence (```markdown, ```md, or just ```)
  if (cleaned.startsWith("```markdown") || cleaned.startsWith("```md") || cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.substring(firstNewline + 1);
    }
  }

  // Check for closing fence (```)
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }

  return cleaned.trim();
}
