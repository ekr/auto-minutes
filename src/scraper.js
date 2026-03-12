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
  // Also accepts interim format: IETF-GROUPNAME-YYYYMMDD-HHMM (no meeting number)
  if (typeof sessionId !== 'string') {
    return false;
  }

  // Pattern breakdown:
  // ^IETF\d*       - Starts with IETF followed by optional meeting number
  // -              - Separator
  // [A-Za-z0-9\-]+ - Session name (alphanumeric + hyphens)
  // -              - Separator
  // \d{8}          - Date in YYYYMMDD format
  // -              - Separator
  // \d{4}$         - Time in HHMM format
  const pattern = /^IETF\d*-[A-Za-z0-9\-]+-\d{8}-\d{4}$/;
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

/**
 * Fetches the current or next upcoming IETF meeting number from the datatracker API.
 * "Current" means a meeting whose date range includes today, or the next future meeting
 * if no meeting is currently in progress.
 * @returns {Promise<number>} The current/upcoming IETF meeting number
 */
export async function fetchCurrentMeetingNumber() {
  const url = 'https://datatracker.ietf.org/api/v1/meeting/meeting/?type=ietf&limit=10&order_by=-date&format=json';
  const response = await ietfFetch(url);
  const data = JSON.parse(await response.text());

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const meetings = data.objects;

  // Find a meeting currently in progress (today falls within start..start+days)
  for (const meeting of meetings) {
    const start = new Date(meeting.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + (meeting.days || 7));

    if (today >= start && today <= end) {
      return parseInt(meeting.number, 10);
    }
  }

  // No meeting in progress — find the next upcoming meeting
  let closest = null;
  for (const meeting of meetings) {
    const start = new Date(meeting.date);
    start.setHours(0, 0, 0, 0);
    if (start > today) {
      if (!closest || start < new Date(closest.date)) {
        closest = meeting;
      }
    }
  }

  if (closest) {
    return parseInt(closest.number, 10);
  }

  throw new Error('Could not determine the current IETF meeting number from the datatracker API');
}

/**
 * Extract group name from an interim meeting slug.
 * Format: interim-YYYY-GROUP-NN → GROUP
 * @param {string} slug - Meeting slug (e.g., "interim-2026-aipref-08")
 * @returns {string} Group name
 */
export function extractGroupFromSlug(slug) {
  const parts = slug.split('-');
  if (parts.length < 4) {
    throw new Error(`Cannot extract group from slug: "${slug}"`);
  }
  return parts.slice(2, -1).join('-');
}

/**
 * Scrape a session page to find the Meetecho player link and session ID.
 * @param {string} meetingSlug - Meeting slug (e.g., "interim-2026-aipref-08")
 * @param {string} groupName - Working group name (e.g., "aipref")
 * @returns {Promise<{sessionId: string, recordingUrl: string}|null>} Session info or null if not found
 */
async function scrapeInterimSessionId(meetingSlug, groupName) {
  const sessionUrl = `https://datatracker.ietf.org/meeting/${meetingSlug}/session/${groupName.toLowerCase()}`;
  const sessionResponse = await ietfFetch(sessionUrl);
  const html = await sessionResponse.text();

  const $ = cheerio.load(html);

  let sessionId = null;
  let recordingUrl = null;

  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && href.includes('meetecho-player.ietf.org/playout')) {
      recordingUrl = href;
      try {
        const url = new URL(href);
        sessionId = url.searchParams.get('session');
      } catch (e) {
        // ignore malformed URLs
      }
    }
  });

  if (!sessionId) {
    return null;
  }

  return { sessionId, recordingUrl };
}

/**
 * Query the datatracker API for interim meetings with given parameters.
 * @param {string} queryParams - URL query parameters (e.g., "date=2026-03-03")
 * @returns {Promise<Array>} Array of meeting objects from the API
 */
async function queryInterimMeetings(queryParams) {
  let allObjects = [];
  let url = `https://datatracker.ietf.org/api/v1/meeting/meeting/?type=interim&${queryParams}`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    allObjects = allObjects.concat(data.objects || []);

    if (data.meta && data.meta.next) {
      url = new URL(data.meta.next, 'https://datatracker.ietf.org').href;
    } else {
      url = null;
    }
  }

  return allObjects;
}

/**
 * Fetches session info for an IETF interim meeting given a date and group name.
 * @param {string} date - Meeting date in YYYY-MM-DD format
 * @param {string} groupName - Working group name (e.g., "aipref")
 * @returns {Promise<Array>} Array with single session object {sessionName, sessionId, recordingUrl}
 */
export async function fetchInterimSession(date, groupName) {
  const meetings = await queryInterimMeetings(`date=${date}`);
  if (meetings.length === 0) {
    throw new Error(`No interim meetings found for date ${date}`);
  }

  const groupLower = groupName.toLowerCase();
  const meeting = meetings.find(m =>
    m.number && m.number.toLowerCase().includes(groupLower)
  );

  if (!meeting) {
    const available = meetings.map(m => m.number).join(', ');
    throw new Error(`No interim meeting found for group "${groupName}" on ${date}. Available: ${available}`);
  }

  const meetingSlug = meeting.number;
  console.log(`Found interim meeting: ${meetingSlug}`);

  const result = await scrapeInterimSessionId(meetingSlug, groupLower);
  if (!result) {
    throw new Error(`Could not find Meetecho session ID for ${meetingSlug}`);
  }

  return [{
    sessionName: groupName.toUpperCase(),
    sessionId: result.sessionId,
    recordingUrl: result.recordingUrl,
  }];
}

/**
 * Fetches all interim sessions for a given date.
 * @param {string} date - Meeting date in YYYY-MM-DD format
 * @returns {Promise<Array>} Array of session objects {sessionName, sessionId, recordingUrl}
 */
export async function fetchAllInterimSessions(date) {
  const meetings = await queryInterimMeetings(`date=${date}`);
  if (meetings.length === 0) {
    throw new Error(`No interim meetings found for date ${date}`);
  }

  console.log(`Found ${meetings.length} interim meeting(s) on ${date}`);

  const sessions = [];
  for (const meeting of meetings) {
    const slug = meeting.number;
    const groupName = extractGroupFromSlug(slug);
    console.log(`  Looking up session for ${slug} (group: ${groupName})...`);

    const result = await scrapeInterimSessionId(slug, groupName);
    if (!result) {
      console.warn(`  Warning: No Meetecho link found for ${slug}, skipping`);
      continue;
    }

    sessions.push({
      sessionName: groupName.toUpperCase(),
      sessionId: result.sessionId,
      recordingUrl: result.recordingUrl,
    });
  }

  return sessions;
}

/**
 * Fetches all interim sessions from startDate through today.
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @returns {Promise<Map<string, Array>>} Map of date → array of session objects
 */
export async function fetchInterimSessionsInRange(startDate) {
  const today = new Date().toISOString().split('T')[0];
  const meetings = await queryInterimMeetings(`date__gte=${startDate}&date__lte=${today}&limit=100`);
  if (meetings.length === 0) {
    throw new Error(`No interim meetings found from ${startDate} through ${today}`);
  }

  console.log(`Found ${meetings.length} interim meeting(s) from ${startDate} to ${today}`);

  // Group meetings by date
  const meetingsByDate = new Map();
  for (const meeting of meetings) {
    const date = meeting.date;
    if (!meetingsByDate.has(date)) {
      meetingsByDate.set(date, []);
    }
    meetingsByDate.get(date).push(meeting);
  }

  // Process each date
  const result = new Map();
  for (const [date, dateMeetings] of meetingsByDate) {
    console.log(`\n  Processing ${date} (${dateMeetings.length} meeting(s))...`);
    const sessions = [];

    for (const meeting of dateMeetings) {
      const slug = meeting.number;
      const groupName = extractGroupFromSlug(slug);
      console.log(`    Looking up session for ${slug} (group: ${groupName})...`);

      const scraped = await scrapeInterimSessionId(slug, groupName);
      if (!scraped) {
        console.warn(`    Warning: No Meetecho link found for ${slug}, skipping`);
        continue;
      }

      sessions.push({
        sessionName: groupName.toUpperCase(),
        sessionId: scraped.sessionId,
        recordingUrl: scraped.recordingUrl,
      });
    }

    if (sessions.length > 0) {
      result.set(date, sessions);
    }
  }

  return result;
}
