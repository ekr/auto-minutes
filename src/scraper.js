/**
 * IETF Transcript Scraper
 * Fetches session information and transcripts from IETF datatracker
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';

const USER_AGENT = 'ietf-agenda/0.1 (+https://github.com/ekr/ietf-agenda)';

/**
 * Common fetch function with proper User-Agent header
 * @param {string} url - URL to fetch
 * @returns {Promise<Response>} Fetch response
 */
async function ietfFetch(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response;
}

/**
 * Fetches the proceedings page for a given IETF meeting
 * @param {number} meetingNumber - The IETF meeting number
 * @returns {Promise<Array>} Array of session objects with name, group, and transcript URL
 */
export async function fetchSessionsFromProceedings(meetingNumber) {
  let html;

  // Fetch from server
  const url = `https://datatracker.ietf.org/meeting/${meetingNumber}/proceedings`;
  const response = await ietfFetch(url);
  html = await response.text();

  // TEMPORARY: Check for local file first to avoid Cloudflare bot blocking
  // const localFile = `./IETF ${meetingNumber} Proceedings.html`;
  // try {
  //   html = await fs.readFile(localFile, 'utf-8');
  //   console.log(`Using local file: ${localFile}`);
  // } catch (err) {
  //   // Fall back to fetching from server
  //   const url = `https://datatracker.ietf.org/meeting/${meetingNumber}/proceedings`;
  //   const response = await ietfFetch(url);
  //   html = await response.text();
  // }

  const $ = cheerio.load(html);

  const sessions = [];

  // Find all links to session recordings
  $('a').each((i, elem) => {
    const link = $(elem);
    const href = link.attr('href');
    const text = link.text().trim().toLowerCase();

    // Look for "session recording" links
    if (!href || !text.includes('session recording')) {
      return;
    }

    // Extract session ID from URL
    const url = new URL(href);
    const sessionId = url.searchParams.get('session');

    if (!sessionId) {
      console.warn(`No session ID found in URL: ${href}`);
      return;
    }

    // Find the session name - typically in the same row or nearby heading
    const row = link.closest('tr');
    const firstTd = row.find('td').first();

    // Try to get the session name from a link or div inside the td, excluding badges
    let sessionName = firstTd.find('a').first().text().trim() ||
                     firstTd.find('div').first().find('a').first().text().trim();

    // Fallback to getting all text and cleaning it
    if (!sessionName) {
      sessionName = firstTd.clone()
        .find('.badge').remove().end()  // Remove badge elements
        .text().trim() ||
        row.prevAll('tr').find('th').first().text().trim() ||
        `Session ${i + 1}`;
    }

    sessions.push({
      sessionName: sessionName,
      sessionId: sessionId,
      recordingUrl: href,
    });
  });

  return sessions;
}

/**
 * Fetches the recordings page from Meetecho for a given IETF meeting
 * @param {number} meetingNumber - The IETF meeting number
 * @returns {Promise<Array>} Array of session objects with name, group, and recording URL
 */
export async function fetchSessionsFromAgenda(meetingNumber) {
  const url = `https://www.meetecho.com/ietf${meetingNumber}/recordings/`;
  const response = await ietfFetch(url);
  const html = await response.text();

  const $ = cheerio.load(html);

  const sessions = [];

  // Find all rows in the recordings table (skip the header row)
  $('#recsTable tr').each((i, elem) => {
    const row = $(elem);
    const cells = row.find('td');

    // Skip header rows or rows without proper cells
    if (cells.length < 3) {
      return;
    }

    const sessionName = cells.eq(0).text().trim();
    const dateTime = cells.eq(1).text().trim();
    const recordingLink = cells.eq(2).find('a');
    const recordingUrl = recordingLink.attr('href');

    if (!sessionName || !recordingUrl) {
      return;
    }

    // Extract session ID from the recording URL
    // URL format: https://meetecho-player.ietf.org/playout/?session=IETF123-6LO-20250723-0730
    const url = new URL(recordingUrl);
    const sessionId = url.searchParams.get('session');

    if (!sessionId) {
      console.warn(`No session ID found in URL: ${recordingUrl}`);
      return;
    }

    sessions.push({
      sessionName: sessionName,
      sessionId: sessionId,
      recordingUrl: recordingUrl,
      dateTime: dateTime,
    });
  });

  return sessions;
}

/**
 * Downloads a transcript for a given session
 * @param {Object} session - Session object with sessionId property
 * @returns {Promise<string>} The transcript text content
 */
export async function downloadTranscript(session) {
  // Construct the actual transcript URL from session ID
  const transcriptUrl = `https://meetecho-player.ietf.org/playout/transcripts/${session.sessionId}`;

  const response = await ietfFetch(transcriptUrl);
  return await response.text();
}

/**
 * Validates session ID format
 * Expected format: IETFXXX-SESSIONNAME-YYYYMMDD-HHMM
 * Examples: IETF123-6LO-20250723-0730, IETF112-RTG-AREA-20211112-1200
 * @param {string} sessionId - Session ID to validate
 * @returns {boolean} True if valid, false otherwise
 */
export function isValidSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    return false;
  }

  // Pattern breakdown:
  // ^IETF\d+       - Starts with IETF followed by meeting number
  // -              - Separator
  // [A-Za-z0-9\-]+ - Session name (alphanumeric + hyphens)
  // -              - Separator
  // \d{8}          - Date in YYYYMMDD format
  // -              - Separator
  // \d{4}$         - Time in HHMM format
  const pattern = /^IETF\d+-[A-Za-z0-9\-]+-\d{8}-\d{4}$/;
  return pattern.test(sessionId);
}

/**
 * Wraps a session fetching function to filter out invalid session IDs
 * @param {Function} fetchFunction - Function that fetches sessions (fetchSessionsFromProceedings or fetchSessionsFromAgenda)
 * @param {number} meetingNumber - IETF meeting number
 * @returns {Promise<Object>} Object with {validSessions: Array, invalidSessions: Array, stats: Object}
 */
export async function fetchSessionsWithValidation(fetchFunction, meetingNumber) {
  // Call the underlying fetch function
  const allSessions = await fetchFunction(meetingNumber);

  // Separate valid and invalid sessions
  const validSessions = [];
  const invalidSessions = [];

  for (const session of allSessions) {
    if (isValidSessionId(session.sessionId)) {
      validSessions.push(session);
    } else {
      invalidSessions.push(session);
    }
  }

  // Log warnings for invalid sessions
  if (invalidSessions.length > 0) {
    console.warn(`\n[Session Validation] Found ${invalidSessions.length} session(s) with invalid IDs:`);
    for (const session of invalidSessions) {
      console.warn(`  - "${session.sessionName}" has invalid ID: "${session.sessionId}"`);
    }
    console.warn(`[Session Validation] These sessions will be skipped.\n`);
  }

  // Return both valid and invalid for transparency
  return {
    validSessions,
    invalidSessions,
    stats: {
      total: allSessions.length,
      valid: validSessions.length,
      invalid: invalidSessions.length,
      validationRate: allSessions.length > 0
        ? ((validSessions.length / allSessions.length) * 100).toFixed(1) + '%'
        : '0%'
    }
  };
}

/**
 * Fetches sessions and returns only those with valid session IDs
 * Convenience wrapper that returns just the valid sessions array
 * @param {Function} fetchFunction - Function that fetches sessions
 * @param {number} meetingNumber - IETF meeting number
 * @returns {Promise<Array>} Array of sessions with valid IDs
 */
export async function fetchValidSessions(fetchFunction, meetingNumber) {
  const result = await fetchSessionsWithValidation(fetchFunction, meetingNumber);
  return result.validSessions;
}
