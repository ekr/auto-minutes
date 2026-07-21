import { amendMinutes } from "./generator.js";
import { recordUsage } from "./accounting.js";
import { getCachedMinutes, loadCacheManifest, saveCachedMinutes } from "./publisher.js";

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

  for (const session of group.sessions) {
    try {
      const existingMinutes = await loadMinutes(meetingId, session.sessionId);
      const result = await reviseMinutes(existingMinutes, comments, group.sessionName, verbose, modelName);
      await saveMinutes(meetingId, session.sessionId, result.text);
      addUsage(result.usage);
      logger.log(`Amended: ${session.sessionId}`);
    } catch (error) {
      logger.error(`Could not amend ${session.sessionId}: ${error.message}`);
    }
  }
}
