import {
  fetchSessionSlidesAndBluesheet,
  fetchWorkingGroupDocuments,
  fetchSessionPolls,
  fetchSessionChatlog,
} from "./scraper.js";
import { saveCacheMetadata } from "./publisher.js";

function sessionSlugFromId(sessionId) {
  const parts = sessionId.split('-');
  return parts.slice(1, -2).join('-').toLowerCase();
}

export async function fetchContextForSession(session, { verbose = false, log = console.log } = {}) {
  let meetingIdentifier;
  let sessionSlug;
  const meetingMatch = session.sessionId.match(/^IETF(\d+)-/);

  if (meetingMatch) {
    meetingIdentifier = parseInt(meetingMatch[1], 10);
    sessionSlug = sessionSlugFromId(session.sessionId);
  } else if (session.meetingSlug) {
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

  if (verbose && slidesResult.status === 'rejected') log(`    [context] Could not fetch slides/bluesheet: ${slidesResult.reason?.message}`);
  if (verbose && docsResult.status === 'rejected') log(`    [context] Could not fetch WG documents: ${docsResult.reason?.message}`);
  if (verbose && pollsResult.status === 'rejected') log(`    [context] Could not fetch polls: ${pollsResult.reason?.message}`);
  if (verbose && chatResult.status === 'rejected') log(`    [context] Could not fetch chat: ${chatResult.reason?.message}`);

  return {
    slidesAndBluesheet: slidesResult.status === 'fulfilled' ? slidesResult.value : null,
    wgDocuments: docsResult.status === 'fulfilled' ? docsResult.value : [],
    polls: pollsResult.status === 'fulfilled' ? pollsResult.value : [],
    chat: chatResult.status === 'fulfilled' ? chatResult.value : [],
  };
}

export async function saveContextMetadata(meetingNumber, sessionId, context) {
  return saveCacheMetadata(meetingNumber, sessionId, {
    slides: context.slidesAndBluesheet?.slides || [],
    bluesheetText: context.slidesAndBluesheet?.bluesheet || null,
    polls: context.polls || [],
    chat: context.chat || [],
  });
}
