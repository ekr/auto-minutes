/**
 * Minutes Generator using Claude API
 * Converts transcripts into structured meeting minutes
 */

import Anthropic from '@anthropic-ai/sdk';

let anthropic = null;

/**
 * Initialize the Claude API client
 * @param {string} apiKey - Anthropic API key
 */
export function initializeClaude(apiKey) {
  anthropic = new Anthropic({ apiKey });
}

/**
 * Generate meeting minutes from a transcript using Claude
 * @param {string} transcript - The meeting transcript text (JSON format)
 * @param {string} sessionName - Name of the session
 * @returns {Promise<string>} Generated minutes in Markdown format
 */
export async function generateMinutes(transcript, sessionName) {
  if (!anthropic) {
    throw new Error('Claude API not initialized. Call initializeClaude() first.');
  }

  const prompt = `You are an expert technical writer for the IETF. Convert the following meeting transcript into well-structured meeting minutes in Markdown format.

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

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  return message.content[0].text;
}
