/**
 * Minutes Generator using Gemini API
 * Converts transcripts into structured meeting minutes
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI = null;

/**
 * Initialize the Gemini API client
 * @param {string} apiKey - Gemini API key
 */
export function initializeGemini(apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
}

/**
 * Generate meeting minutes from a transcript using Gemini
 * @param {string} transcript - The meeting transcript text
 * @param {string} sessionName - Name of the session
 * @returns {Promise<string>} Generated minutes in Markdown format
 */
export async function generateMinutes(transcript, sessionName) {
  if (!genAI) {
    throw new Error('Gemini API not initialized. Call initializeGemini() first.');
  }

  // TODO: Implement Gemini API call with appropriate prompt
  // Format output as Markdown

  throw new Error('Not yet implemented');
}
