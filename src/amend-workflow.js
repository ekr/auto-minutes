import fsPromises from "fs/promises";
import { existsSync } from "fs";
import { amendMinutes, splitAmendComments, getTranscriptCorrections, filterTranscriptCorrections } from "./generator.js";
import { recordUsage } from "./accounting.js";
import { getCachedMetadata, getCachedMinutes, loadCacheManifest, saveCachedMinutes } from "./publisher.js";
import { fetchContextForSession } from "./session-context.js";
import { normalizeCorrections, applyCorrections } from "./transcript-cleanup.js";
import { getTranscriptCachePath } from "./transcriber.js";
import { downloadTranscript } from "./scraper.js";

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

  const splitComments = dependencies.splitAmendComments ?? splitAmendComments;
  const getCorrections = dependencies.getTranscriptCorrections ?? getTranscriptCorrections;
  const filterCorrections = dependencies.filterTranscriptCorrections ?? filterTranscriptCorrections;
  const normalize = dependencies.normalizeCorrections ?? normalizeCorrections;
  const apply = dependencies.applyCorrections ?? applyCorrections;
  const getTranscriptPath = dependencies.getTranscriptCachePath ?? getTranscriptCachePath;
  const download = dependencies.downloadTranscript ?? downloadTranscript;

  const fsReadFile = dependencies.readFile ?? dependencies.fs?.readFile ?? fsPromises.readFile;
  const fsWriteFile = dependencies.writeFile ?? dependencies.fs?.writeFile ?? fsPromises.writeFile;
  const fsExistsSync = dependencies.existsSync ?? dependencies.fs?.existsSync ?? existsSync;

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

  let splitResult = null;
  try {
    splitResult = await splitComments(comments, group.sessionName, verbose, modelName);
    if (splitResult?.usage) {
      addUsage(splitResult.usage);
    }
  } catch (error) {
    logger.error(`Could not split amend comments: ${error.message}`);
    splitResult = { transcriptInstructions: "", minutesInstructions: comments };
  }

  const transcriptInstructions = splitResult?.transcriptInstructions ?? "";
  const minutesInstructions = splitResult?.minutesInstructions ?? "";

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

      let transcriptChanges = null;
      if (transcriptInstructions && transcriptInstructions.trim()) {
        try {
          const cachePath = getTranscriptPath(session.sessionId);
          let transcriptText;
          if (fsExistsSync(cachePath)) {
            transcriptText = await fsReadFile(cachePath, "utf8");
          } else {
            transcriptText = await download({ ...session, sessionName: group.sessionName });
          }

          if (transcriptText) {
            const rawCorrections = await getCorrections(
              transcriptText,
              transcriptInstructions,
              group.sessionName,
              context,
              verbose,
              modelName,
            );
            if (rawCorrections?.usage) {
              addUsage(rawCorrections.usage);
            }
            const candidateCorrections = normalize(rawCorrections);
            let corrections = candidateCorrections;
            if (candidateCorrections.length > 0) {
              const filteredCorrections = await filterCorrections(
                candidateCorrections,
                transcriptInstructions,
                group.sessionName,
                verbose,
                modelName,
              );
              if (filteredCorrections?.usage) {
                addUsage(filteredCorrections.usage);
              }
              corrections = normalize(filteredCorrections);
            }

            const { text: updatedTranscript, applied } = apply(transcriptText, corrections);
            if (applied && applied.length > 0) {
              await fsWriteFile(cachePath, updatedTranscript, "utf8");
              transcriptChanges = applied
                .map(({ from, to }) => (to ? `- "${from}" → "${to}"` : `- removed: "${from}"`))
                .join("\n");
            }
          }
        } catch (tError) {
          logger.error(`Transcript step failed for ${session.sessionId}: ${tError.message}`);
          // A transcript-processing error (e.g. an LLM API 503) means the requested
          // amendment did not happen. Propagate it so this session is recorded as a
          // failure and the command exits non-zero, instead of silently falling
          // through to the "no changes" skip below and letting the caller (the
          // GitHub Action) close the issue as a success.
          throw tError;
        }
      }

      if ((minutesInstructions && minutesInstructions.trim()) || transcriptChanges) {
        const result = await reviseMinutes(
          existingMinutes,
          minutesInstructions,
          group.sessionName,
          verbose,
          modelName,
          context,
          transcriptChanges,
        );
        await saveMinutes(meetingId, session.sessionId, result.text);
        if (result?.usage) {
          addUsage(result.usage);
        }
        logger.log(`Amended: ${session.sessionId}`);
      } else {
        logger.log(`Skipped amending ${session.sessionId}: no minutes instructions or transcript changes`);
      }
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
