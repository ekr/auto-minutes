/**
 * Publisher
 * Handles writing generated minutes to local filesystem
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * @returns {Promise<Array<string>>} List of generated files
 */
export async function generateIndex(sessions, outputDir = 'output') {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Generate index content
  let content = '# Meeting Minutes Index\n\n';
  content += `Generated: ${new Date().toISOString()}\n\n`;
  content += '## Sessions\n\n';

  const generatedFiles = ['index.md'];

  for (const sessionName of sessions) {
    const sanitizedName = sanitizeSessionName(sessionName);
    const filename = `${sanitizedName}.md`;
    content += `- [${sessionName}](${filename})\n`;

    // Track both .md and .txt files
    generatedFiles.push(`${sanitizedName}.md`);
    generatedFiles.push(`${sanitizedName}.txt`);
  }

  // Write index file
  const filepath = path.join(outputDir, 'index.md');
  await fs.writeFile(filepath, content, 'utf-8');

  // Write manifest file
  const manifestPath = path.join(outputDir, '.manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    generated: new Date().toISOString(),
    files: generatedFiles
  }, null, 2), 'utf-8');

  return generatedFiles;
}

/**
 * Generate root index.md for GitHub Pages from template
 * Scans output/ directory for meeting folders and adds them to the index
 * @param {string} outputDir - Base output directory (default: 'output')
 * @param {string} destPath - Destination path for the index file
 */
export async function generateRootIndex(outputDir = 'output', destPath = 'gh-pages-repo/docs/index.md') {
  // Read the template
  const templatePath = path.join(__dirname, '..', 'templates', 'index.md');
  let template = await fs.readFile(templatePath, 'utf-8');

  // Scan output directory for ietf* folders
  let meetings = [];
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    meetings = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('ietf'))
      .map(entry => {
        // Extract meeting number from ietf123 format
        const match = entry.name.match(/^ietf(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter(num => num !== null)
      .sort((a, b) => a - b); // Numerical order
  } catch (error) {
    console.warn('Could not read output directory:', error.message);
  }

  // Generate meeting links
  let meetingsList = '';
  if (meetings.length > 0) {
    for (const meetingNum of meetings) {
      meetingsList += `- [IETF ${meetingNum}](ietf${meetingNum}/index.md)\n`;
    }
  } else {
    meetingsList = 'No meetings processed yet.\n';
  }

  // Replace the meetings section (after "# Meetings")
  const meetingsMarker = '# Meetings\n';
  const markerIndex = template.indexOf(meetingsMarker);
  if (markerIndex !== -1) {
    const beforeMarker = template.substring(0, markerIndex + meetingsMarker.length);
    template = beforeMarker + '\n' + meetingsList;
  } else {
    // If marker not found, append to end
    template += '\n\n# Meetings\n\n' + meetingsList;
  }

  // Write the index file
  await fs.writeFile(destPath, template, 'utf-8');
}
