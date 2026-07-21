import { amendMinutes } from "./generator.js";
import { recordUsage } from "./accounting.js";
import { getCachedMetadata, getCachedMinutes, loadCacheManifest, saveCachedMinutes } from "./publisher.js";
import { fetchContextForSession } from "./session-context.js";

/**
 * Amend every cached session belonging to one WG.
 *
 * Dependencies are injectable so the cache-mutation orchestration can be
 * tested without making an LLM request.
 */
export async function amendCachedSessions({
  meetingId,
  groupName,
  comments,
  verbose = false,
  modelName = null,
  dependencies = {},
}) {
  const loadManifest = dependencies.loadCacheManifest ?? loadCacheManifest;
  const loadMinutes = dependencies.getCachedMinutes ?? getCachedMinutes;
  const loadMetadata = dependencies.getCachedMetadata ?? getCachedMetadata;
  const fetchContext = dependencies.fetchContextForSession ?? fetchContextForSession;
  const reviseMinutes = dependencies.amendMinutes ?? amendMinutes;
  const saveMinutes = dependencies.saveCachedMinutes ?? saveCachedMinutes;
  const addUsage = dependencies.recordUsage ?? recordUsage;
  const logger = dependencies.logger ?? console;

  let sessionGroups;
  try {
    sessionGroups = await loadManifest(meetingId);
  } catch {
    throw new Error(`No cached minutes for ${meetingId}; run --summarize first`);
  }

  const group = sessionGroups.find(
    candidate => candidate.sessionName.toLowerCase() === groupName.toLowerCase(),
  );
  if (!group) {
    const available = sessionGroups.map(candidate => candidate.sessionName).sort().join(", ");
    throw new Error(`No cached minutes for ${groupName} in ${meetingId}; run --summarize first. Available: ${available || "none"}`);
  }

  const failures = [];
  for (const session of group.sessions) {
    try {
      const existingMinutes = await loadMinutes(meetingId, session.sessionId);
      let context = null;
      try {
        context = await fetchContext(
          { sessionId: session.sessionId, sessionName: group.sessionName },
          verbose,
        );
      } catch {
        // Live context is optional and must never prevent an amendment.
      }
      const liveHasSlidesAndBluesheet = context && (
        context.slidesAndBluesheet?.slides?.length > 0
        || context.slidesAndBluesheet?.bluesheet
      );
      if (!liveHasSlidesAndBluesheet) {
        let metadata = null;
        try {
          metadata = await loadMetadata(meetingId, session.sessionId);
        } catch {
          // Cached metadata is optional and must never prevent an amendment.
        }
        if (metadata) {
          context = {
            slidesAndBluesheet: {
              slides: metadata.slides || [],
              bluesheet: metadata.bluesheetText || null,
            },
            wgDocuments: context?.wgDocuments || [],
            polls: metadata.polls || [],
            chat: metadata.chat || [],
          };
        }
      }
      const result = await reviseMinutes(existingMinutes, comments, group.sessionName, verbose, modelName, context);
      await saveMinutes(meetingId, session.sessionId, result.text);
      addUsage(result.usage);
      logger.log(`Amended: ${session.sessionId}`);
    } catch (error) {
      failures.push(session.sessionId);
      logger.error(`Could not amend ${session.sessionId}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to amend ${failures.length} session(s): ${failures.join(", ")}`,
    );
  }
}
