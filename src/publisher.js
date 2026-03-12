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
 * @param {number|string} meetingId - IETF meeting number or date string (e.g., "2026-03-03")
 * @returns {string} Cache directory path
 */
function getCacheDir(meetingId) {
  if (typeof meetingId === 'number' || /^\d+$/.test(meetingId)) {
    return path.join("cache", "output", `ietf${meetingId}`);
  }
  // Date string or other identifier
  return path.join("cache", "output", String(meetingId));
}

/**
 * Get all cached meeting IDs (numbers for plenary, date strings for interims)
 * @returns {Promise<Array<number|string>>} Array of meeting IDs
 */
export async function getCachedMeetingIds() {
  const cacheBase = path.join("cache", "output");

  try {
    const entries = await fs.readdir(cacheBase, { withFileTypes: true });
    const meetingIds = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Match ietfNNN format (plenary meetings)
      const ietfMatch = entry.name.match(/^ietf(\d+)$/);
      if (ietfMatch) {
        meetingIds.push(parseInt(ietfMatch[1], 10));
        continue;
      }

      // Match YYYY-MM-DD format (interim meetings)
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        meetingIds.push(entry.name);
      }
    }

    // Sort: numbers descending, then date strings descending
    meetingIds.sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return b - a;
      if (typeof a === 'string' && typeof b === 'string') return b.localeCompare(a);
      // Numbers before strings
      if (typeof a === 'number') return -1;
      return 1;
    });

    return meetingIds;
  } catch (error) {
    // Cache directory doesn't exist yet
    return [];
  }
}

/** @deprecated Use getCachedMeetingIds instead */
export async function getCachedMeetingNumbers() {
  const ids = await getCachedMeetingIds();
  return ids.filter(id => typeof id === 'number');
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
    return entries.filter((entry) => !entry.startsWith("."));
  } catch (error) {
    // Cache directory doesn't exist yet
    return [];
  }
}

/**
 * Save session metadata manifest to cache
 * @param {number} meetingNumber - IETF meeting number
 * @param {Array<Object>} sessionGroups - Array of {sessionName, sessions: [{sessionId, recordingUrl}]}
 */
export async function saveCacheManifest(meetingNumber, sessionGroups) {
  const cacheDir = getCacheDir(meetingNumber);
  await fs.mkdir(cacheDir, { recursive: true });

  const manifestPath = path.join(cacheDir, ".manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        sessionGroups,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/**
 * Load session metadata manifest from cache
 * @param {number} meetingNumber - IETF meeting number
 * @returns {Promise<Array<Object>>} Array of {sessionName, sessions: [{sessionId, recordingUrl}]}
 */
export async function loadCacheManifest(meetingNumber) {
  const cacheDir = getCacheDir(meetingNumber);
  const manifestPath = path.join(cacheDir, ".manifest.json");

  const content = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(content);
  return manifest.sessionGroups;
}

/**
 * Save minutes to the output directory
 * @param {string} sessionName - Name of the session
 * @param {string} content - The markdown content
 * @param {string} outputDir - Directory to save files (default: 'output')
 * @param {Array<string>} recordingUrls - Array of recording URLs for this session
 */
export async function saveMinutes(
  sessionName,
  content,
  outputDir = "output",
  recordingUrls = [],
) {
  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Create sanitized filename from session name
  const sanitizedName = sanitizeSessionName(sessionName);
  const txtFilename = `${sanitizedName}.txt`;

  // Build header with links
  let header = `[Markdown Version](${txtFilename})`;

  // Add recording link(s)
  if (recordingUrls.length > 0) {
    if (recordingUrls.length === 1) {
      header += ` | [Session Recording](${recordingUrls[0]})`;
    } else {
      // Multiple recordings for this session
      const recordingLinks = recordingUrls
        .map((url, idx) => `[Recording ${idx + 1}](${url})`)
        .join(" | ");
      header += ` | ${recordingLinks}`;
    }
  }

  const contentWithLink = `${header}\n\n${content}`;

  // Write markdown file
  const mdFilename = `${sanitizedName}.md`;
  const mdFilepath = path.join(outputDir, mdFilename);
  await fs.writeFile(mdFilepath, contentWithLink, "utf-8");

  // Write text file (same content)
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
 * Generate per-WG pages showing all meetings for each WG in reverse chronological order
 * @param {string} siteDir - Base site directory (default: 'site')
 */
export async function generateWgPages(siteDir = "site") {
  const cacheOutputDir = path.join("cache", "output");
  const meetingNumbers = await getCachedMeetingNumbers();

  if (meetingNumbers.length === 0) {
    console.log("No cached meetings found, skipping WG page generation");
    return;
  }

  // Build map of WG name -> [{meetingNumber, sanitizedName}]
  const wgMeetings = new Map();

  for (const meetingNum of meetingNumbers) {
    try {
      const manifestPath = path.join(
        cacheOutputDir,
        `ietf${meetingNum}`,
        ".manifest.json",
      );
      const content = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(content);

      for (const group of manifest.sessionGroups) {
        const name = group.sessionName;
        if (!wgMeetings.has(name)) {
          wgMeetings.set(name, []);
        }
        wgMeetings.get(name).push(meetingNum);
      }
    } catch (error) {
      console.warn(
        `Could not read manifest for IETF ${meetingNum}: ${error.message}`,
      );
    }
  }

  // Generate WG directory
  const wgDir = path.join(siteDir, "minutes", "wg");
  await fs.mkdir(wgDir, { recursive: true });

  // Generate a page for each WG
  const wgNames = [...wgMeetings.keys()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  for (const wgName of wgNames) {
    const meetings = wgMeetings.get(wgName);
    // Already sorted descending from getCachedMeetingNumbers
    const sanitizedWg = sanitizeSessionName(wgName);

    let content = `# ${wgName}\n\n`;

    for (const meetingNum of meetings) {
      content += `- [IETF ${meetingNum}](../ietf${meetingNum}/${sanitizedWg}.html)\n`;
    }

    const wgFilePath = path.join(wgDir, `${sanitizedWg}.md`);
    await fs.writeFile(wgFilePath, content, "utf-8");
  }

  // Generate WG index page
  let indexContent = "# Working Groups\n\n";
  for (const wgName of wgNames) {
    const sanitizedWg = sanitizeSessionName(wgName);
    indexContent += `- [${wgName}](${sanitizedWg}.html)\n`;
  }

  const indexPath = path.join(wgDir, "index.md");
  await fs.writeFile(indexPath, indexContent, "utf-8");

  console.log(`Generated ${wgNames.length} WG pages`);
}

/**
 * Generate root index.md from template
 * Scans cache/output for meeting folders and adds them to the index
 * @param {string} destPath - Destination path for the index file (default: 'site/index.md')
 */
export async function generateRootIndex(destPath = "site/index.md") {
  // Read the template
  const templatePath = path.join(__dirname, "..", "templates", "index.md");
  let template = await fs.readFile(templatePath, "utf-8");

  // Scan cache/output directory for ietf* folders
  let meetings = [];
  const cacheOutputDir = path.join("cache", "output");
  try {
    const entries = await fs.readdir(cacheOutputDir, { withFileTypes: true });
    meetings = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ietf"))
      .map((entry) => {
        // Extract meeting number from ietf123 format
        const match = entry.name.match(/^ietf(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((num) => num !== null)
      .sort((a, b) => b - a); // Descending numerical order
  } catch (error) {
    console.warn("Could not read cache/output directory:", error.message);
  }

  // Generate meeting links
  let meetingsList = "";
  if (meetings.length > 0) {
    for (const meetingNum of meetings) {
      meetingsList += `- [IETF ${meetingNum}](minutes/ietf${meetingNum}/index.html)\n`;
    }
  } else {
    meetingsList = "No meetings processed yet.\n";
  }

  // Add WG index link
  let wgSection = "";
  if (meetings.length > 0) {
    wgSection = "\n# Working Groups\n\n[Browse by working group](minutes/wg/index.html)\n";
  }

  // Replace the meetings section (after "# Meetings")
  const meetingsMarker = "# Meetings\n";
  const markerIndex = template.indexOf(meetingsMarker);
  if (markerIndex !== -1) {
    const beforeMarker = template.substring(
      0,
      markerIndex + meetingsMarker.length,
    );
    template = beforeMarker + "\n" + meetingsList + wgSection;
  } else {
    // If marker not found, append to end
    template += "\n\n# Meetings\n\n" + meetingsList + wgSection;
  }

  // Write the index file
  await fs.writeFile(destPath, template, "utf-8");
}
