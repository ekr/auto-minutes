/**
 * Publisher
 * Handles writing generated minutes to local filesystem
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Save minutes to the output directory
 * @param {string} sessionName - Name of the session
 * @param {string} content - The markdown content
 * @param {string} outputDir - Directory to save files (default: 'output')
 */
export async function saveMinutes(sessionName, content, outputDir = 'output') {
  // TODO: Implement file writing
  // Create sanitized filename from session name
  // Ensure output directory exists

  throw new Error('Not yet implemented');
}

/**
 * Generate an index page listing all minutes
 * @param {Array<string>} sessions - Array of session names
 * @param {string} outputDir - Directory to save index (default: 'output')
 */
export async function generateIndex(sessions, outputDir = 'output') {
  // TODO: Implement index.md generation
  // Create links to all minute files

  throw new Error('Not yet implemented');
}
