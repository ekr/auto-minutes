/**
 * Publisher
 * Handles writing generated minutes to local filesystem
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Check if minutes already exist for a session
 * @param {string} sessionName - Name of the session
 * @param {string} outputDir - Directory where minutes are saved
 * @returns {Promise<boolean>} True if minutes exist, false otherwise
 */
export async function minutesExist(sessionName, outputDir = "output") {
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
 * Get cache directory for a meeting
 * @param {number} meetingNumber - IETF meeting number
 * @returns {string} Cache directory path
 */
function getCacheDir(meetingNumber) {
  return path.join("cache", "output", `ietf${meetingNumber}`);
}

/**
 * Get cache file path for a specific session
 * @param {number} meetingNumber - IETF meeting number
 * @param {string} sessionId - Session ID
 * @returns {string} Cache file path
 */
function getCacheFile(meetingNumber, sessionId) {
  return path.join(getCacheDir(meetingNumber), sessionId);
}

/**
 * Check if cached minutes exist for a specific session ID
 * @param {number} meetingNumber - IETF meeting number
 * @param {string} sessionId - Session ID
 * @returns {Promise<boolean>} True if cache exists, false otherwise
 */
export async function cacheExists(meetingNumber, sessionId) {
  const cachePath = getCacheFile(meetingNumber, sessionId);

  try {
    await fs.access(cachePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save minutes to cache for a specific session ID
 * @param {number} meetingNumber - IETF meeting number
 * @param {string} sessionId - Session ID
 * @param {string} minutes - Raw LLM-generated minutes (markdown)
 */
export async function saveCachedMinutes(meetingNumber, sessionId, minutes) {
  const cacheDir = getCacheDir(meetingNumber);

  // Ensure cache directory exists
  await fs.mkdir(cacheDir, { recursive: true });

  const cachePath = getCacheFile(meetingNumber, sessionId);
  await fs.writeFile(cachePath, minutes, "utf-8");
}

/**
 * Load cached minutes for a specific session ID
 * @param {number} meetingNumber - IETF meeting number
 * @param {string} sessionId - Session ID
 * @returns {Promise<string>} Cached minutes (raw markdown)
 */
export async function getCachedMinutes(meetingNumber, sessionId) {
  const cachePath = getCacheFile(meetingNumber, sessionId);
  return await fs.readFile(cachePath, "utf-8");
}

/**
 * Get all cached session IDs for a meeting
 * @param {number} meetingNumber - IETF meeting number
 * @returns {Promise<Array<string>>} Array of session IDs
 */
export async function getCachedSessionIds(meetingNumber) {
  const cacheDir = getCacheDir(meetingNumber);

  try {
    const entries = await fs.readdir(cacheDir);
    return entries.filter(entry => !entry.startsWith('.'));
  } catch (error) {
    // Cache directory doesn't exist yet
    return [];
  }
}

/**
 * Save minutes to the output directory
 * @param {string} sessionName - Name of the session
 * @param {string} content - The markdown content
 * @param {string} outputDir - Directory to save files (default: 'output')
 */
export async function saveMinutes(sessionName, content, outputDir = "output") {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Create sanitized filename from session name
  const sanitizedName = sanitizeSessionName(sessionName);
  const mdFilename = `${sanitizedName}.md`;

  // Add markdown version link at the top
  const contentWithLink = `[Markdown Version](${mdFilename})\n\n${content}`;

  // Write markdown file
  const mdFilepath = path.join(outputDir, mdFilename);
  await fs.writeFile(mdFilepath, contentWithLink, "utf-8");

  // Write text file (same content)
  const txtFilename = `${sanitizedName}.txt`;
  const txtFilepath = path.join(outputDir, txtFilename);
  await fs.writeFile(txtFilepath, content, "utf-8");
}

/**
 * Generate an index page listing all minutes
 * @param {Array<string>} sessions - Array of session names
 * @param {string} outputDir - Directory to save index (default: 'output')
 * @returns {Promise<Array<string>>} List of generated files
 */
export async function generateIndex(sessions, outputDir = "output") {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Sort sessions alphabetically (case-insensitive)
  const sortedSessions = [...sessions].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  // Generate index content
  let content = "# Meeting Minutes Index\n\n";
  content += `Generated: ${new Date().toISOString()}\n\n`;
  content += "## Sessions\n\n";

  const generatedFiles = ["index.md"];

  for (const sessionName of sortedSessions) {
    const sanitizedName = sanitizeSessionName(sessionName);
    const filename = `${sanitizedName}.html`;
    const mdFilename = `${sanitizedName}.txt`;
    content += `- [${sessionName}](${filename}) ([markdown](${mdFilename}))\n`;

    // Track both .md and .txt files
    generatedFiles.push(`${sanitizedName}.md`);
    generatedFiles.push(`${sanitizedName}.txt`);
  }

  // Write index file
  const filepath = path.join(outputDir, "index.md");
  await fs.writeFile(filepath, content, "utf-8");

  // Write manifest file
  const manifestPath = path.join(outputDir, ".manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        files: generatedFiles,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return generatedFiles;
}

/**
 * Generate root index.md for GitHub Pages from template
 * Scans output/ directory for meeting folders and adds them to the index
 * @param {string} outputDir - Base output directory (default: 'output')
 * @param {string} destPath - Destination path for the index file
 */
export async function generateRootIndex(
  outputDir = "output",
  destPath = "gh-pages-repo/docs/index.md",
) {
  // Read the template
  const templatePath = path.join(__dirname, "..", "templates", "index.md");
  let template = await fs.readFile(templatePath, "utf-8");

  // Scan output directory for ietf* folders
  let meetings = [];
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    meetings = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ietf"))
      .map((entry) => {
        // Extract meeting number from ietf123 format
        const match = entry.name.match(/^ietf(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((num) => num !== null)
      .sort((a, b) => a - b); // Numerical order
  } catch (error) {
    console.warn("Could not read output directory:", error.message);
  }

  // Generate meeting links
  let meetingsList = "";
  if (meetings.length > 0) {
    for (const meetingNum of meetings) {
      meetingsList += `- [IETF ${meetingNum}](ietf${meetingNum}/index.md)\n`;
    }
  } else {
    meetingsList = "No meetings processed yet.\n";
  }

  // Replace the meetings section (after "# Meetings")
  const meetingsMarker = "# Meetings\n";
  const markerIndex = template.indexOf(meetingsMarker);
  if (markerIndex !== -1) {
    const beforeMarker = template.substring(
      0,
      markerIndex + meetingsMarker.length,
    );
    template = beforeMarker + "\n" + meetingsList;
  } else {
    // If marker not found, append to end
    template += "\n\n# Meetings\n\n" + meetingsList;
  }

  // Write the index file
  await fs.writeFile(destPath, template, "utf-8");
}
