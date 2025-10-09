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
  currentModel = 'claude';
}

/**
 * Initialize the Gemini API client
 * @param {string} apiKey - Google API key
 */
export function initializeGemini(apiKey) {
  gemini = new GoogleGenerativeAI(apiKey);
  currentModel = 'gemini';
}

/**
 * Generate meeting minutes from a transcript using the configured model
 * @param {string} transcript - The meeting transcript text (JSON format)
 * @param {string} sessionName - Name of the session
 * @returns {Promise<string>} Generated minutes in Markdown format
 */
export async function generateMinutes(transcript, sessionName) {
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

The transcript is in JSON format with timestamps and text. Here is the transcript:

${transcript}

Generate the meeting minutes:`;

  if (currentModel === 'claude') {
    if (!anthropic) {
      throw new Error("Claude API not initialized. Call initializeClaude() first.");
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

    return message.content[0].text;
  } else if (currentModel === 'gemini') {
    if (!gemini) {
      throw new Error("Gemini API not initialized. Call initializeGemini() first.");
    }

    const model = gemini.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text();
  } else {
    throw new Error("No model initialized. Call initializeClaude() or initializeGemini() first.");
  }
}
