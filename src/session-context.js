import { fetchSessionSlidesAndBluesheet, fetchWorkingGroupDocuments, fetchSessionPolls, fetchSessionChatlog } from "./scraper.js";

/**
 * Extract the session slug from a session ID.
 * Session ID format: IETF{N}-{SLUG...}-{YYYYMMDD}-{HHMM}
 * The slug can contain hyphens (e.g., "rtg-area"), so we strip the IETF prefix
 * and the trailing date/time components.
 * @param {string} sessionId - e.g. "IETF124-PRIVACYPASS-20251105-1700"
 * @returns {string} Lowercase slug, e.g. "privacypass" or "rtg-area"
 */
export function sessionSlugFromId(sessionId) {
  const parts = sessionId.split('-');
  // parts[0] = "IETF124", last two = "YYYYMMDD", "HHMM"
  return parts.slice(1, -2).join('-').toLowerCase();
}

/**
 * Fetch slides/bluesheet, WG documents, polls, and chatlog for a session in parallel.
 * Supports both regular IETF meetings (numeric ID) and interim meetings
 * (meetingSlug present on the session object, e.g. "interim-2026-dnssd-01").
 * Returns empty context gracefully when the session cannot be resolved and
 * fails each individual fetch soft.
 * @param {Object} session - Session object with sessionId (and optionally meetingSlug) property
 * @param {boolean} verbose - Whether to log individual context fetch failures
 * @returns {Promise<{slidesAndBluesheet: Object|null, wgDocuments: Array, polls: Array, chat: Array}>}
 */
export async function fetchContextForSession(session, verbose = false) {
  let meetingIdentifier;
  let sessionSlug;

  const meetingMatch = session.sessionId.match(/^IETF(\d+)-/);
  if (meetingMatch) {
    meetingIdentifier = parseInt(meetingMatch[1], 10);
    sessionSlug = sessionSlugFromId(session.sessionId);
  } else if (session.meetingSlug) {
    // Interim session: use the stored meeting slug and derive group from session name
    meetingIdentifier = session.meetingSlug;
    sessionSlug = session.sessionName.toLowerCase();
  } else {
    return { slidesAndBluesheet: null, wgDocuments: [], polls: [], chat: [] };
  }

  const [slidesResult, docsResult, pollsResult, chatResult] = await Promise.allSettled([
    fetchSessionSlidesAndBluesheet(meetingIdentifier, sessionSlug),
    fetchWorkingGroupDocuments(sessionSlug),
    fetchSessionPolls(meetingIdentifier, session.sessionId, session.meetingSlug),
    fetchSessionChatlog(meetingIdentifier, session.sessionId, session.meetingSlug),
  ]);

  if (verbose && slidesResult.status === 'rejected') {
    console.log(`    [context] Could not fetch slides/bluesheet: ${slidesResult.reason?.message}`);
  }
  if (verbose && docsResult.status === 'rejected') {
    console.log(`    [context] Could not fetch WG documents: ${docsResult.reason?.message}`);
  }
  if (verbose && pollsResult.status === 'rejected') {
    console.log(`    [context] Could not fetch polls: ${pollsResult.reason?.message}`);
  }
  if (verbose && chatResult.status === 'rejected') {
    console.log(`    [context] Could not fetch chat: ${chatResult.reason?.message}`);
  }

  return {
    slidesAndBluesheet: slidesResult.status === 'fulfilled' ? slidesResult.value : null,
    wgDocuments: docsResult.status === 'fulfilled' ? docsResult.value : [],
    polls: pollsResult.status === 'fulfilled' && Array.isArray(pollsResult.value) ? pollsResult.value : [],
    chat: chatResult.status === 'fulfilled' && Array.isArray(chatResult.value) ? chatResult.value : [],
  };
}
