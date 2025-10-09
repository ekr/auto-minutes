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
export async function fetchMeetingSessions(meetingNumber) {
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
