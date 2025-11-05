/**
 * Minutes Generator using Claude or Gemini API
 * Converts transcripts into structured meeting minutes
 */

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
 * Generate meeting minutes from a transcript using the configured model
 * @param {string} transcript - The meeting transcript text (JSON format)
 * @param {string} sessionName - Name of the session
 * @param {boolean} verbose - Whether to log verbose status information
 * @returns {Promise<string>} Generated minutes in Markdown format
 */
export async function generateMinutes(transcript, sessionName, verbose = false) {
  const prompt = `You are an expert technical writer for the IETF. Convert the following meeting transcript into well-structured meeting minutes in Markdown format. It should contain an account of the discussion including any decisions made.

Session: ${sessionName}

Requirements:
- Start with a # header with the session name
- Include a ## Summary section with a brief overview
- Include a ## Key Discussion Points section with bullet points
- Include a ## Decisions and Action Items section if applicable
- Include a ## Next Steps section if applicable
- Be concise but capture all important technical discussions
- Use proper Markdown formatting
- Focus on technical content and decisions
- Remember that IETF participants are individuals, not representatives of companies or other entities
- Don't state or imply that consensus was reached at the meeting. It's OK to say things like "a poll of the room was taken" or "a sense of those present indicates..."

The transcript is in JSON format with timestamps and text. Here is the transcript:

${transcript}

Generate the meeting minutes:`;

  if (verbose) {
    console.log(`    [LLM] Model: ${currentModel}`);
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

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

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

    const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
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
