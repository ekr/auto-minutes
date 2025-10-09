/**
 * Publisher
 * Handles writing generated minutes to local filesystem
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Sanitize a session name to create a valid filename
 * @param {string} sessionName - Name of the session
 * @returns {string} Sanitized filename-safe string
 */
export function sanitizeSessionName(sessionName) {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check if minutes already exist for a session
 * @param {string} sessionName - Name of the session
 * @param {string} outputDir - Directory where minutes are saved
 * @returns {Promise<boolean>} True if minutes exist, false otherwise
 */
export async function minutesExist(sessionName, outputDir = 'output') {
  const sanitizedName = sanitizeSessionName(sessionName);
  const filename = `${sanitizedName}.md`;
  const filepath = path.join(outputDir, filename);

  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save minutes to the output directory
 * @param {string} sessionName - Name of the session
 * @param {string} content - The markdown content
 * @param {string} outputDir - Directory to save files (default: 'output')
 */
export async function saveMinutes(sessionName, content, outputDir = 'output') {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Create sanitized filename from session name
  const sanitizedName = sanitizeSessionName(sessionName);

  // Write markdown file
  const mdFilename = `${sanitizedName}.md`;
  const mdFilepath = path.join(outputDir, mdFilename);
  await fs.writeFile(mdFilepath, content, 'utf-8');

  // Write text file (same content)
  const txtFilename = `${sanitizedName}.txt`;
  const txtFilepath = path.join(outputDir, txtFilename);
  await fs.writeFile(txtFilepath, content, 'utf-8');
}

/**
 * Generate an index page listing all minutes
 * @param {Array<string>} sessions - Array of session names
 * @param {string} outputDir - Directory to save index (default: 'output')
 */
export async function generateIndex(sessions, outputDir = 'output') {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Generate index content
  let content = '# Meeting Minutes Index\n\n';
  content += `Generated: ${new Date().toISOString()}\n\n`;
  content += '## Sessions\n\n';

  for (const sessionName of sessions) {
    const sanitizedName = sanitizeSessionName(sessionName);
    const filename = `${sanitizedName}.md`;
    content += `- [${sessionName}](./${filename})\n`;
  }

  // Write index file
  const filepath = path.join(outputDir, 'index.md');
  await fs.writeFile(filepath, content, 'utf-8');
}
