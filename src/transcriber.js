/**
 * Audio Transcription Module
 * Downloads session audio from Cloudflare via Meetecho and transcribes using Gemini STT
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { downloadTranscript } from "./scraper.js";
import { buildContextPrompt, assertTranscriptPresent, transcriptWordCount, extractParticipantNames, activeDraftNames } from "./generator.js";
import { getSpeakerMapFromGemini, normalizeSpeakerMap, applySpeakerMap, formatOffset, parseOffset } from "./speaker-names.js";
import { recordUsage } from "./accounting.js";

const AUDIO_CACHE_DIR = path.join("cache", "audio");
const TRANSCRIPT_CACHE_DIR = path.join("cache", "transcripts");

// Audio transcripts are typically ~88% of official transcript word count (based on TLS/IETF124).
// If below this ratio, the transcription was likely truncated.
const TRUNCATION_RATIO_THRESHOLD = 0.6;

// Conversational speech runs 120-150 wpm; this is a floor that only catches gross failure
// (e.g. a session that transcribed to near-zero words), not genuinely slow-paced sessions.
const MIN_WORDS_PER_MINUTE = 30;

// Upload retry: initial attempt + 3 retries, exponential backoff capped at 15s.
const MAX_UPLOAD_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 2000;
const UPLOAD_RETRY_CAP_MS = 15000;

// Resumable upload: send the file in bounded chunks so no single request is large
// enough to hit a transport-level timeout (see the 408s that motivated this).
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
const GEMINI_FILES_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";

/**
 * Determine whether an error from the Gemini File API upload is worth retrying.
 * Transient: HTTP 408/429/500/502/503/504, common Node network error codes, or
 * a "socket hang up"/network/fetch-failed message. A 429 whose message indicates
 * depleted billing credits is treated as permanent since it will not self-resolve.
 * @param {Error} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (!error) return false;

  const message = typeof error.message === "string" ? error.message : "";

  if (/credits are depleted|billing/i.test(message)) {
    return false;
  }

  const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
  const statusMatch = message.match(/\[(\d{3})\b/);
  const status = error.status ?? (statusMatch ? parseInt(statusMatch[1], 10) : null);
  if (status !== null && TRANSIENT_STATUSES.has(status)) {
    return true;
  }

  const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ENOTFOUND"]);
  if (error.code && TRANSIENT_CODES.has(error.code)) {
    return true;
  }

  if (/socket hang up|network|fetch failed/i.test(message)) {
    return true;
  }

  return false;
}

/**
 * Fetch the Cloudflare video ID for a session from the Meetecho sessions API
 * @param {string} sessionId - Meetecho session ID (e.g., IETF124-PLENARY-20250723-0730)
 * @returns {Promise<string>} Cloudflare video ID
 */
export async function fetchCloudflareVideoId(sessionId) {
  const url = `https://meetecho-player.ietf.org/playout/sessions/${sessionId}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ietf-auto-minutes/0.1 (+https://github.com/ekr/auto-minutes)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch session info: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.videos || !Array.isArray(data.videos)) {
    throw new Error(`No videos found for session ${sessionId}`);
  }

  // Find the Cloudflare video (type 3)
  const cfVideo = data.videos.find((v) => v.type === 3);
  if (!cfVideo) {
    throw new Error(`No Cloudflare video found for session ${sessionId} (available types: ${data.videos.map((v) => v.type).join(', ')})`);
  }

  return cfVideo.src;
}

/**
 * Get the lowest-bandwidth HLS variant URL for a session.
 * Fetches the master playlist and selects the variant with the smallest bandwidth,
 * so ffmpeg downloads the least video data (the audio is the same across all variants).
 * @param {string} sessionId - Meetecho session ID
 * @returns {Promise<string>} HLS variant stream URL
 */
export async function getAudioStreamUrl(sessionId) {
  const videoId = await fetchCloudflareVideoId(sessionId);
  const masterUrl = `https://videodelivery.net/${videoId}/manifest/video.m3u8`;

  const response = await fetch(masterUrl, {
    headers: {
      'User-Agent': 'ietf-auto-minutes/0.1 (+https://github.com/ekr/auto-minutes)',
    },
  });
  if (!response.ok) {
    // Fall back to master URL if we can't fetch the playlist
    return masterUrl;
  }

  const playlist = await response.text();

  // Look for a dedicated audio rendition (EXT-X-MEDIA TYPE=AUDIO with a URI)
  const audioMedia = playlist.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/);
  if (audioMedia) {
    return new URL(audioMedia[1], masterUrl).href;
  }

  // Fallback: select the lowest bandwidth variant (audio is muxed in)
  let lowestBandwidth = Infinity;
  let lowestVariantUri = null;
  const lines = playlist.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
    if (match) {
      const bandwidth = parseInt(match[1], 10);
      const uri = lines[i + 1]?.trim();
      if (uri && bandwidth < lowestBandwidth) {
        lowestBandwidth = bandwidth;
        lowestVariantUri = uri;
      }
    }
  }

  if (!lowestVariantUri) {
    return masterUrl;
  }

  // Variant URIs may be relative; resolve against the master URL
  return new URL(lowestVariantUri, masterUrl).href;
}

/**
 * Run a child process asynchronously (via spawn, no shell) without blocking the
 * event loop, unlike execSync/spawnSync. Resolves on exit code 0, rejects with an
 * Error including the command label and captured stderr otherwise.
 * @param {string} command - Executable to run (e.g. "ffmpeg", "ffprobe")
 * @param {string[]} args - Argument array (no shell involved, so no quoting/injection concerns)
 * @param {{verbose?: boolean, captureStdout?: boolean, label?: string}} [opts]
 * @returns {Promise<string|undefined>} Captured stdout (utf-8) when captureStdout is true, otherwise undefined
 */
function runProcess(command, args, { verbose = false, captureStdout = false, label = command } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdoutChunks = [];
    const stderrChunks = [];

    if (captureStdout) {
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    } else if (verbose) {
      child.stdout.pipe(process.stdout);
    }

    if (verbose) {
      child.stderr.pipe(process.stderr);
    } else {
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    }

    child.on("error", (error) => {
      reject(new Error(`${label} failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(captureStdout ? Buffer.concat(stdoutChunks).toString("utf-8") : undefined);
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        reject(new Error(`${label} exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

/**
 * Download audio from an HLS stream to a local MP3 file using ffmpeg
 * @param {string} streamUrl - HLS stream URL
 * @param {string} outputPath - Local file path for the MP3
 * @param {boolean} verbose - Whether to show ffmpeg output
 * @returns {Promise<void>}
 */
export async function downloadAudio(streamUrl, outputPath, verbose = false) {
  await runProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", streamUrl, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outputPath],
    { verbose, label: "ffmpeg download" },
  );
}

/**
 * Run a single upload request with retry/backoff, reusing the same transient-error
 * classification as the rest of the upload path. Retries the given async operation
 * in place (e.g. re-sending one chunk at its offset), not the whole upload.
 * @param {() => Promise<T>} attemptFn
 * @param {string} label - short description used in retry log lines
 * @returns {Promise<T>}
 * @template T
 */
async function withUploadRetry(attemptFn, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await attemptFn();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_UPLOAD_ATTEMPTS || !isTransientError(error)) {
        throw error;
      }
      // Equal-jitter: half the exponential backoff is fixed, half is randomized, so
      // concurrent uploads that fail together (e.g. simultaneous event-loop-stall
      // timeouts under -j concurrency) don't all retry at the exact same instant.
      const exp = Math.min(UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1), UPLOAD_RETRY_CAP_MS);
      const delay = Math.floor(exp / 2 + Math.random() * (exp / 2));
      console.log(
        `    [Transcribe] ${label} attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS} failed (${error.message}); retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Build an Error from a failed upload HTTP response, shaped like the SDK's own
 * errors (status on the error object, "[<status> <statusText>] ..." message) so
 * isTransientError classifies it correctly.
 * @param {import('node-fetch').Response} response
 * @param {string} bodySnippet
 * @returns {Error}
 */
function uploadHttpError(response, bodySnippet) {
  const error = new Error(`[${response.status} ${response.statusText}] ${bodySnippet.slice(0, 500)}`);
  error.status = response.status;
  return error;
}

/**
 * Upload a file to the Gemini Files API using the resumable upload protocol
 * (X-Goog-Upload-Protocol: resumable), sending the file in bounded chunks rather
 * than a single multipart request. This avoids transport-level timeouts on large
 * (48-83 MB) session audio files. Returns a response shaped like the SDK's
 * fileManager.uploadFile: { file: { name, uri, mimeType, state, ... } }.
 * @param {string} audioPath - Path to the local file to upload
 * @param {string} apiKey - Gemini API key
 * @param {{mimeType?: string, displayName?: string, verbose?: boolean}} [options]
 * @returns {Promise<{file: {name: string, uri: string, mimeType: string, state: string}}>}
 */
export async function uploadFileResumable(audioPath, apiKey, { mimeType = "audio/mpeg", displayName, verbose = false } = {}) {
  const { size: fileSize } = fs.statSync(audioPath);
  const name = displayName || path.basename(audioPath);

  if (verbose) {
    console.log(`    [Transcribe] Starting resumable upload (${fileSize} bytes)`);
  }

  const uploadUrl = await withUploadRetry(async () => {
    const response = await fetch(`${GEMINI_FILES_UPLOAD_URL}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(fileSize),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: name } }),
    });

    if (!response.ok) {
      throw uploadHttpError(response, await response.text().catch(() => ""));
    }

    const url = response.headers.get("x-goog-upload-url");
    if (!url) {
      throw new Error("Gemini resumable upload start response did not include an X-Goog-Upload-URL header");
    }
    return url;
  }, "Upload start");

  const handle = await fsPromises.open(audioPath, "r");
  try {
    let offset = 0;
    let finalizeBody = null;

    do {
      const chunkSize = Math.min(UPLOAD_CHUNK_SIZE, fileSize - offset);
      const buffer = Buffer.alloc(chunkSize);
      if (chunkSize > 0) {
        await handle.read(buffer, 0, chunkSize, offset);
      }
      const chunkOffset = offset;
      offset += chunkSize;
      const isLast = offset >= fileSize;

      finalizeBody = await withUploadRetry(async () => {
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Length": String(buffer.length),
            "X-Goog-Upload-Offset": String(chunkOffset),
            "X-Goog-Upload-Command": isLast ? "upload, finalize" : "upload",
          },
          body: buffer,
        });

        if (!response.ok) {
          throw uploadHttpError(response, await response.text().catch(() => ""));
        }

        return isLast ? await response.json() : null;
      }, `Upload chunk at offset ${chunkOffset}`);
    } while (offset < fileSize);

    if (!finalizeBody?.file) {
      throw new Error("Gemini resumable upload finalize response did not include a file");
    }
    if (verbose) {
      console.log(`    [Transcribe] Resumable upload finalized: ${finalizeBody.file.name}`);
    }
    return finalizeBody;
  } finally {
    await handle.close();
  }
}

/**
 * Transcribe an audio file using Gemini File API
 * @param {string} audioPath - Path to the audio file
 * @param {string} apiKey - Gemini API key
 * @param {string} model - Gemini model name
 * @param {boolean} verbose - Whether to log verbose output
 * @param {Object} context - Pre-fetched session context (optional, used to help identify speakers)
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, model: string}}>} Transcript text and token usage
 */
export async function transcribeAudio(audioPath, apiKey, model = "gemini-3.5-flash", verbose = false, context = null) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  let dotCount = 0;
  const writeDot = (ch = ".") => {
    process.stdout.write(ch);
    dotCount++;
    if (dotCount % 20 === 0) process.stdout.write("\n");
  };
  const requestOptions = { timeout: 600000 }; // 10 minutes for long audio
  const genModel = genAI.getGenerativeModel(
    { model, generationConfig: { maxOutputTokens: 65535, thinkingConfig: { thinkingLevel: "low" } } },
    requestOptions,
  );

  let fileName;

  try {
    if (verbose) {
      console.log(`    [Transcribe] Uploading file: ${audioPath}`);
    }

    // Re-throwing an exhausted-retries or permanent error here (rather than swallowing
    // it) is intentional and safe: every caller of transcribeAudio/transcribeSession
    // (generateSessionMinutes and the preview loop in src/index.js) already wraps the
    // call in a try/catch that logs and skips just this session, so this drops one
    // session's minutes without aborting the batch run.
    const uploadResponse = await uploadFileResumable(audioPath, apiKey, {
      mimeType: "audio/mpeg",
      displayName: path.basename(audioPath),
      verbose,
    });

    fileName = uploadResponse.file.name;

    if (verbose) {
      console.log(`    [Transcribe] Upload complete. File name: ${fileName}`);
      console.log(`    [Transcribe] Waiting for file processing...`);
    }

    // Wait for file to be ready
    let file;
    let retries = 0;
    const maxRetries = 10;

    while (true) {
      try {
        file = await fileManager.getFile(fileName);
        if (file.state !== "PROCESSING") {
          break;
        }
        if (verbose) {
          writeDot(".");
        }
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }
        if (verbose) {
          writeDot("r");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (file.state === "FAILED") {
      throw new Error(`File processing failed: ${file.state}`);
    }

    if (verbose) {
      console.log("\n    [Transcribe] File ready. Generating transcript...");
    }

    // Stream transcript with retry on stream errors.
    // On retry, feed the last 500 words back and ask the model to continue.
    const contextBlock = buildContextPrompt(context, "");
    const INITIAL_PROMPT = `${contextBlock}Please provide a complete verbatim transcript of the ENTIRE audio from start to finish. Do not stop early or summarize — transcribe every word spoken throughout the full recording. Output the transcript in Markdown format. Identify speakers and label each speaker change with the speaker name in bold (e.g., '**Speaker 1:** ...', '**Jane Smith:** ...'). If you can identify speakers by name from context, use their names instead of generic labels.`;
    const MAX_STREAM_RETRIES = 3;
    const allText = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, model };

    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      const soFar = allText.join("");
      let prompt;
      if (attempt === 0 || !soFar.trim()) {
        // Nothing usable transcribed yet — start over rather than feeding a
        // "continue from here" prompt with an empty "here".
        prompt = INITIAL_PROMPT;
        if (attempt > 0) {
          console.log(`    [Transcribe] Retry ${attempt}/${MAX_STREAM_RETRIES}: no transcript produced yet, restarting from the beginning`);
        }
      } else {
        prompt = `Continue transcribing from where the previous transcription was cut off. Here is everything that was already transcribed:\n\n${soFar}\n\nContinue the verbatim transcript from exactly this point to the end of the audio. Do not repeat any of the text above — only output new transcript text. Maintain the same speaker labeling format.`;
        console.log(`    [Transcribe] Retry ${attempt}/${MAX_STREAM_RETRIES}: continuing from ${soFar.length} chars`);
      }

      const streamResult = await genModel.generateContentStream([
        {
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri,
          },
        },
        { text: prompt },
      ]);

      // Suppress unhandled rejection from .response if the stream fails
      streamResult.response.catch(() => {});

      const chunks = [];
      let chunkIndex = 0;
      let lastFinishReason = null;
      let lastChunkRaw = null;
      try {
        for await (const chunk of streamResult.stream) {
          const finishReason = chunk.candidates?.[0]?.finishReason;
          if (finishReason) lastFinishReason = finishReason;
          lastChunkRaw = chunk;
          const safetyRatings = chunk.candidates?.[0]?.safetyRatings;
          const blocked = safetyRatings?.some(r => r.blocked);
          if (verbose && blocked) {
            console.log(`    [Transcribe] Chunk ${chunkIndex} BLOCKED: ${JSON.stringify(safetyRatings)}`);
          }
          const text = chunk.text();
          if (text) {
            chunks.push(text);
            if (verbose) {
              writeDot(".");
            }
          }
          chunkIndex++;
        }
      } catch (streamError) {
        const chunkText = chunks.join("");
        if (verbose) {
          console.error(`\n    [Transcribe] Stream error after ${chunkIndex} chunks (${chunkText.length} chars): ${streamError.message}`);
          console.error(`    [Transcribe] Last finishReason: ${lastFinishReason}`);
          if (lastChunkRaw) {
            try {
              console.error(`    [Transcribe] Last chunk raw: ${JSON.stringify(lastChunkRaw)}`);
            } catch (_) { /* ignore circular refs */ }
          }
        }
        // Keep whatever we got before the error
        if (chunkText.length > 0) {
          allText.push(chunkText);
        }
        if (attempt === MAX_STREAM_RETRIES) {
          throw streamError;
        }
        continue;
      }

      // Stream completed without a transport error — but an empty result is
      // still a failure. This is exactly how the DISPATCH-20260720 session was
      // silently lost: a zero-chunk stream was previously treated as success.
      const chunkText = chunks.join("");
      if (!chunkText.trim()) {
        console.warn(`    [Transcribe] Attempt ${attempt} produced no transcript text (finishReason=${lastFinishReason}, chunks=${chunkIndex})`);
        const safetyRatings = lastChunkRaw?.candidates?.[0]?.safetyRatings;
        if (safetyRatings) {
          console.warn(`    [Transcribe] Last safety ratings: ${JSON.stringify(safetyRatings)}`);
        }
        if (attempt === MAX_STREAM_RETRIES) {
          throw new Error(`Gemini STT returned no transcript text for ${path.basename(audioPath)} after ${MAX_STREAM_RETRIES + 1} attempts (last finishReason: ${lastFinishReason})`);
        }
        continue;
      }

      allText.push(chunkText);

      // Get usage metadata from the aggregated response
      try {
        const aggregatedResponse = await streamResult.response;
        const usageMeta = aggregatedResponse.usageMetadata;
        if (usageMeta) {
          totalUsage.inputTokens += usageMeta.promptTokenCount || 0;
          totalUsage.outputTokens += usageMeta.candidatesTokenCount || 0;
        }
      } catch (_) { /* usage metadata is best-effort */ }

      if (verbose) {
        console.log(`\n    [Transcribe] Attempt ${attempt}: ${chunks.length} chunks, ${chunkText.length} chars, finishReason=${lastFinishReason}`);
      }
      break; // success, no more retries
    }

    const transcript = allText.join("");
    const usage = totalUsage;

    if (verbose) {
      console.log(`    [Transcribe] Final transcript: ${transcript.length} chars (${allText.length} segment(s))`);
      console.log(`    [Transcribe] Tokens: ${usage.inputTokens} in, ${usage.outputTokens} out`);
    }
    return { text: transcript, usage };
  } finally {
    // Clean up remote file
    if (typeof fileName !== "undefined") {
      try {
        if (verbose) {
          console.log(`    [Transcribe] Deleting remote file: ${fileName}`);
        }
        await fileManager.deleteFile(fileName);
      } catch (deleteError) {
        if (verbose) {
          console.error(`    [Transcribe] Failed to delete remote file: ${deleteError.message}`);
        }
      }
    }
  }
}

/**
 * Get the cached audio file path for a session
 * @param {string} sessionId - Session ID
 * @returns {string} Path to cached audio file
 */
export function getAudioCachePath(sessionId) {
  return path.join(AUDIO_CACHE_DIR, `${sessionId}.mp3`);
}

/**
 * Check if cached audio exists for a session
 * @param {string} sessionId - Session ID
 * @returns {boolean} True if cached audio exists
 */
function audioCacheExists(sessionId) {
  return fs.existsSync(getAudioCachePath(sessionId));
}

/**
 * Get the cached transcript file path for a session
 * @param {string} sessionId - Session ID
 * @returns {string} Path to cached transcript file
 */
export function getTranscriptCachePath(sessionId) {
  return path.join(TRANSCRIPT_CACHE_DIR, `${sessionId}.md`);
}

/**
 * Get audio duration in seconds using ffprobe
 * @param {string} audioPath - Path to audio file
 * @returns {Promise<number>} Duration in seconds
 */
async function getAudioDuration(audioPath) {
  const output = await runProcess(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", audioPath],
    { captureStdout: true, label: "ffprobe" },
  );
  return parseFloat(output.trim());
}

/**
 * Split audio into segments of a given duration
 * @param {string} audioPath - Path to audio file
 * @param {number} segmentSeconds - Segment duration in seconds
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<string[]>} Array of segment file paths (in a temp directory)
 */
async function splitAudio(audioPath, segmentSeconds, verbose = false) {
  const tempDir = path.join(os.tmpdir(), `auto-minutes-segments-${randomUUID()}`);
  await fsPromises.mkdir(tempDir, { recursive: true });

  const ext = path.extname(audioPath);
  const pattern = path.join(tempDir, `segment%03d${ext}`);

  if (verbose) {
    console.log(`    [GoogleSTT] Splitting audio into ${segmentSeconds}s segments...`);
  }
  await runProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", audioPath, "-f", "segment", "-segment_time", String(segmentSeconds), "-c", "copy", pattern],
    { verbose, label: "ffmpeg split" },
  );

  const files = (await fsPromises.readdir(tempDir))
    .filter(f => f.startsWith("segment"))
    .sort()
    .map(f => path.join(tempDir, f));

  if (verbose) {
    console.log(`    [GoogleSTT] Split into ${files.length} segments`);
  }
  return files;
}

/**
 * Format a "[HH:MM:SS] " timestamp prefix for a turn's first word offset.
 * Falls back to no prefix (never "[NaN:NaN:NaN]") if the offset is missing/unparseable.
 * @param {string|number|Object|undefined} rawOffset - Google STT v2 REST offset value
 * @returns {string} Timestamp prefix, or empty string
 */
function formatTimestampPrefix(rawOffset) {
  const seconds = parseOffset(rawOffset);
  if (seconds === null) return "";
  return `[${formatOffset(seconds)}] `;
}

/**
 * Format Google STT diarized words into "[HH:MM:SS] Speaker N: ..." turns,
 * breaking a new line each time the speaker label changes.
 * @param {Array<{word: string, speakerLabel?: string, startOffset?: *}>} words
 * @returns {string} Formatted transcript text
 */
export function formatDiarizedTranscript(words) {
  let currentSpeaker = null;
  let turnStartOffset = null;
  const lines = [];
  let currentLine = [];

  const flushLine = () => {
    if (currentLine.length > 0) {
      lines.push(`${formatTimestampPrefix(turnStartOffset)}Speaker ${currentSpeaker}: ${currentLine.join(" ")}`);
      currentLine = [];
    }
  };

  for (const word of words) {
    if (word.speakerLabel && word.speakerLabel !== currentSpeaker) {
      flushLine();
      currentSpeaker = word.speakerLabel;
      turnStartOffset = word.startOffset;
    }
    currentLine.push(word.word);
  }
  flushLine();

  return lines.join("\n");
}

/**
 * Transcribe an audio file using Google Cloud Speech-to-Text (batch recognition)
 * Splits files longer than 30 minutes into segments and recognizes them all in one batch call.
 * @param {string} audioPath - Path to the local audio file
 * @param {string} model - STT model name (e.g., "chirp_3", "chirp_2")
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, model: string}}|string>} Transcript text (with usage when transcription occurs, plain string from cache)
 */
export async function transcribeAudioGoogleSTT(audioPath, model = "chirp_3", verbose = false, segmentSeconds = 1800) {
  const { Storage } = await import("@google-cloud/storage");

  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error("GCS_BUCKET environment variable is required for --stt-model google");
  }

  const storage = new Storage();
  // chirp_3 requires multi-region "us" endpoint; chirp_2 uses us-central1
  let apiEndpoint;
  if (model === "chirp_3") {
    apiEndpoint = "us-speech.googleapis.com";
  } else if (model.startsWith("chirp")) {
    apiEndpoint = "us-central1-speech.googleapis.com";
  }

  // Check duration and split if needed
  const duration = await getAudioDuration(audioPath);
  const SEGMENT_SECONDS = segmentSeconds; // Use passed chunk size
  let audioFiles;
  let tempSegmentDir = null;

  if (duration > SEGMENT_SECONDS) {
    audioFiles = await splitAudio(audioPath, SEGMENT_SECONDS, verbose);
    tempSegmentDir = path.dirname(audioFiles[0]);
  } else {
    audioFiles = [audioPath];
  }

  // Upload all files to GCS
  const gcsFileNames = [];
  const gcsUris = [];
  for (const file of audioFiles) {
    const gcsName = `auto-minutes-tmp/${randomUUID()}${path.extname(file)}`;
    gcsFileNames.push(gcsName);
    gcsUris.push(`gs://${bucketName}/${gcsName}`);
  }

  try {
    if (verbose) {
      console.log(`    [GoogleSTT] Uploading ${audioFiles.length} file(s) to GCS...`);
    }
    await Promise.all(
      audioFiles.map((file, i) =>
        storage.bucket(bucketName).upload(file, { destination: gcsFileNames[i] })
      ),
    );

    if (verbose) {
      console.log(`    [GoogleSTT] Upload complete. Starting batch recognition...`);
    }

    // Use REST API for batch recognize, polling, and results (gRPC LRO blocks event loop)
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const projectId = await auth.getProjectId();
    let location = "global";
    if (model === "chirp_3") location = "us";
    else if (model.startsWith("chirp")) location = "us-central1";
    const restHost = apiEndpoint || "speech.googleapis.com";
    const recognizer = `projects/${projectId}/locations/${location}/recognizers/_`;

    // Launch a single batchRecognize call for a given GCS URI; returns the LRO name
    async function launchBatchRecognize(uri) {
      const launchToken = await auth.getAccessToken();
      const res = await fetch(
        `https://${restHost}/v2/${recognizer}:batchRecognize`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${launchToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            config: {
              languageCodes: ["en-US"],
              model,
              autoDecodingConfig: {},
              features: model === "chirp_3" ? {
                diarizationConfig: {},
                enableWordTimeOffsets: true,
              } : undefined,
            },
            files: [{ uri }],
            recognitionOutputConfig: {
              inlineResponseConfig: {},
            },
          }),
        },
      );
      const data = await res.json();
      if (data.error) {
        throw new Error(`BatchRecognize failed: ${data.error.message}`);
      }
      return data.name;
    }

    // Launch parallel batch recognize calls via REST
    if (verbose) {
      console.log(`    [GoogleSTT] Starting ${gcsUris.length} batch recognition(s)...`);
    }
    const opNames = await Promise.all(gcsUris.map(uri => launchBatchRecognize(uri)));

    for (let i = 0; i < opNames.length; i++) {
      console.log(`    [GoogleSTT] Segment ${i}: operation ${opNames[i]}`);
    }

    // Poll until all complete. Detect stalls (no progress for STALL_THRESHOLD_MS)
    // and restart the segment up to MAX_RETRIES_PER_SEGMENT times.
    const STALL_THRESHOLD_MS = 5 * 60 * 1000;
    const MAX_RETRIES_PER_SEGMENT = 2;
    console.log(`    [GoogleSTT] Waiting for ${opNames.length} transcription(s) to complete...`);
    const startTime = Date.now();
    const completed = new Array(opNames.length).fill(false);
    const opResults = new Array(opNames.length).fill(null);
    const lastProgressPct = new Array(opNames.length).fill(0);
    const lastProgressTime = new Array(opNames.length).fill(startTime);
    const retryCount = new Array(opNames.length).fill(0);

    while (completed.some(c => !c)) {
      await new Promise(resolve => setTimeout(resolve, 30000));
      const now = Date.now();
      const elapsed = Math.round((now - startTime) / 1000);
      const pollToken = await auth.getAccessToken();
      const statuses = [];
      for (let i = 0; i < opNames.length; i++) {
        if (completed[i]) {
          statuses.push(`seg${i}: done`);
          continue;
        }
        try {
          const res = await fetch(`https://${restHost}/v2/${opNames[i]}`, {
            headers: { Authorization: `Bearer ${pollToken}` },
          });
          const data = await res.json();
          if (data.done) {
            completed[i] = true;
            opResults[i] = data.response;
            statuses.push(`seg${i}: done`);
            continue;
          }
          const pct = data.metadata?.progressPercent || 0;
          if (pct > lastProgressPct[i]) {
            lastProgressPct[i] = pct;
            lastProgressTime[i] = now;
          }
          const stalledMs = now - lastProgressTime[i];
          if (stalledMs >= STALL_THRESHOLD_MS) {
            if (retryCount[i] >= MAX_RETRIES_PER_SEGMENT) {
              throw new Error(
                `Segment ${i} stalled at ${pct}% after ${retryCount[i]} retries; giving up.`,
              );
            }
            retryCount[i]++;
            const stalledSec = Math.round(stalledMs / 1000);
            console.log(
              `    [GoogleSTT] Segment ${i} stalled at ${pct}% for ${stalledSec}s — cancelling and retrying (${retryCount[i]}/${MAX_RETRIES_PER_SEGMENT})`,
            );
            // Best-effort cancel of the stuck operation
            try {
              await fetch(`https://${restHost}/v2/${opNames[i]}:cancel`, {
                method: "POST",
                headers: { Authorization: `Bearer ${pollToken}` },
              });
            } catch (_) { /* best-effort */ }
            // Re-launch for the same GCS URI
            const newOpName = await launchBatchRecognize(gcsUris[i]);
            opNames[i] = newOpName;
            lastProgressPct[i] = 0;
            lastProgressTime[i] = now;
            console.log(`    [GoogleSTT] Segment ${i}: new operation ${newOpName}`);
            statuses.push(`seg${i}: restarted`);
          } else {
            statuses.push(`seg${i}: ${pct}%`);
          }
        } catch (e) {
          statuses.push(`seg${i}: error(${e.message.slice(0, 40)})`);
        }
      }
      console.log(`    [GoogleSTT] ${elapsed}s: ${statuses.join(", ")}`);
    }

    if (verbose) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`    [GoogleSTT] All transcriptions complete (${elapsed}s)`);
    }

    // Extract transcripts from REST responses
    const transcriptParts = [];
    for (let i = 0; i < gcsUris.length; i++) {
      const response = opResults[i];
      const fileResult = response.results && response.results[gcsUris[i]];
      if (!fileResult) continue;

      if (fileResult.error && fileResult.error.message) {
        throw new Error(`Google STT error for segment ${i}: ${fileResult.error.message}`);
      }

      const transcriptData = fileResult.inlineResult && fileResult.inlineResult.transcript;
      if (transcriptData && transcriptData.results) {
        for (const result of transcriptData.results) {
          if (result.alternatives && result.alternatives.length > 0) {
            const alt = result.alternatives[0];
            // If diarization produced per-word speaker labels, format with speaker changes
            if (alt.words && alt.words.some(w => w.speakerLabel)) {
              transcriptParts.push(formatDiarizedTranscript(alt.words));
            } else {
              transcriptParts.push(alt.transcript);
            }
          }
        }
      }
    }

    const transcript = transcriptParts.join("\n");
    if (verbose) {
      console.log(`    [GoogleSTT] Transcript: ${transcriptParts.length} parts, ${transcript.length} chars`);
    }
    return transcript;
  } finally {
    // Clean up GCS files
    await Promise.all(
      gcsFileNames.map(async (name) => {
        try {
          await storage.bucket(bucketName).file(name).delete();
        } catch (e) {
          if (verbose) {
            console.error(`    [GoogleSTT] Failed to delete gs://${bucketName}/${name}: ${e.message}`);
          }
        }
      }),
    );
    if (verbose) {
      console.log(`    [GoogleSTT] Cleaned up ${gcsFileNames.length} GCS file(s)`);
    }

    // Clean up temp segment directory
    if (tempSegmentDir) {
      await fsPromises.rm(tempSegmentDir, { recursive: true, force: true });
    }
  }
}

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

// Cap on total keyterms sent to Deepgram, to keep the request URL a sane size.
const MAX_DEEPGRAM_KEYTERMS = 100;

// Deepgram rejects requests whose keyterms sum to more than 500 tokens across
// all keyterms ("Keyterm limit exceeded"). We don't have Deepgram's tokenizer,
// so we estimate conservatively and stay under a safety margin below 500.
const DEEPGRAM_KEYTERM_TOKEN_BUDGET = 450;

/**
 * Conservatively estimate how many tokens Deepgram will count for a keyterm.
 * Deepgram appears to split on whitespace and hyphens (e.g. draft names like
 * `draft-ietf-foo-bar`) and may break long words into sub-word pieces, so we
 * over-count rather than risk exceeding the hard limit.
 * @param {string} term
 * @returns {number} Estimated token count (at least 1)
 */
function estimateKeytermTokens(term) {
  const segments = term.split(/[\s-]+/).filter(Boolean);
  let tokens = 0;
  for (const segment of segments) {
    tokens += Math.max(1, Math.ceil(segment.length / 6));
  }
  return Math.max(1, tokens);
}

/**
 * Build a deduped (case-insensitive), capped list of domain keyterms for
 * Deepgram keyterm boosting, seeded from the session's bluesheet participant
 * names and active draft names. The list is capped both by term count
 * (MAX_DEEPGRAM_KEYTERMS) and by estimated total tokens
 * (DEEPGRAM_KEYTERM_TOKEN_BUDGET) so the request stays under Deepgram's
 * 500-token keyterm limit.
 * @param {Object|null} context - Pre-fetched session context
 * @returns {string[]} Keyterms, capped by count and estimated token budget
 */
export function buildDeepgramKeyterms(context) {
  const participantNames = extractParticipantNames(context?.slidesAndBluesheet?.bluesheet);
  const draftNames = activeDraftNames(context?.wgDocuments || []).map(doc => doc.Name);

  const seen = new Set();
  const keyterms = [];
  let tokenBudget = DEEPGRAM_KEYTERM_TOKEN_BUDGET;
  for (const term of [...participantNames, ...draftNames]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    const tokens = estimateKeytermTokens(term);
    // Skip (don't stop) terms that don't fit, so shorter later terms can still
    // be included once budget runs low.
    if (tokens > tokenBudget) continue;
    seen.add(key);
    keyterms.push(term);
    tokenBudget -= tokens;
    if (keyterms.length >= MAX_DEEPGRAM_KEYTERMS) break;
  }
  return keyterms;
}

/**
 * Format Deepgram diarized words into "[HH:MM:SS] Speaker N: ..." turns,
 * breaking a new line each time the (0-based) speaker index changes.
 * @param {Array<{word: string, punctuated_word?: string, start?: number, speaker?: number}>} words
 * @returns {string} Formatted transcript text
 */
export function formatDeepgramTranscript(words) {
  let currentSpeaker = null;
  let turnStartOffset = null;
  const lines = [];
  let currentLine = [];

  const flushLine = () => {
    if (currentLine.length > 0) {
      lines.push(`${formatTimestampPrefix(turnStartOffset)}Speaker ${currentSpeaker}: ${currentLine.join(" ")}`);
      currentLine = [];
    }
  };

  for (const word of words) {
    if (typeof word.speaker === "number" && word.speaker !== currentSpeaker) {
      flushLine();
      currentSpeaker = word.speaker;
      turnStartOffset = word.start;
    }
    currentLine.push(word.punctuated_word || word.word);
  }
  flushLine();

  return lines.join("\n");
}

/**
 * Transcribe an audio file using Deepgram's prerecorded (batch) API.
 * Sends the whole file as the request body in a single call (no chunking,
 * no GCS bucket); Deepgram returns word-level timestamps and diarization
 * together, which are formatted into the same "[HH:MM:SS] Speaker N: ..."
 * shape produced by the chirp backend.
 * @param {string} audioPath - Path to the local audio file
 * @param {string} model - Deepgram model name (e.g. "nova-3", "nova-2")
 * @param {boolean} verbose - Whether to log verbose output
 * @param {string[]} keyterms - Domain keyterms to boost (participant names, active drafts)
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeAudioDeepgram(audioPath, model = "nova-3", verbose = false, keyterms = []) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is required for --stt-model deepgram");
  }

  const { size: fileSize } = fs.statSync(audioPath);

  const params = new URLSearchParams();
  params.set("model", model);
  params.set("diarize", "true");
  params.set("punctuate", "true");
  params.set("smart_format", "true");
  // nova-3 introduced the `keyterm` param; earlier models use `keywords`.
  const keytermParam = model.startsWith("nova-3") ? "keyterm" : "keywords";
  for (const term of keyterms) {
    params.append(keytermParam, term);
  }

  if (verbose) {
    console.log(`    [Deepgram] POST ${DEEPGRAM_LISTEN_URL} model=${model}, ${keyterms.length} keyterm(s)`);
  }

  const data = await withUploadRetry(async () => {
    // Stream the file from disk rather than buffering it in memory: a Readable is
    // single-use, so it must be created fresh on every retry attempt (a re-sent
    // stream from a prior attempt would be empty/consumed).
    const body = fs.createReadStream(audioPath);
    const response = await fetch(`${DEEPGRAM_LISTEN_URL}?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/mpeg",
        "Content-Length": String(fileSize),
      },
      body,
    });

    if (!response.ok) {
      throw uploadHttpError(response, await response.text().catch(() => ""));
    }

    return response.json();
  }, "Deepgram transcription");

  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) {
    throw new Error("Deepgram response did not include a transcript");
  }

  const hasDiarizedWords = Array.isArray(alt.words) && alt.words.some(w => typeof w.speaker === "number");
  if (hasDiarizedWords) {
    const transcript = formatDeepgramTranscript(alt.words);
    if (verbose) {
      console.log(`    [Deepgram] Transcript: ${alt.words.length} words, ${transcript.length} chars`);
    }
    return transcript;
  }

  return alt.transcript || "";
}

/**
 * Prepare a local audio/video file for use in the pipeline.
 * Converts the file to MP3 via ffmpeg and places it in the audio cache slot for the session.
 *
 * Caches the conversion via a sidecar fingerprint (absolute path + size + mtime).
 * If the sidecar matches the current input, reuses the cached MP3 and leaves the
 * transcript cache intact. If the input differs (or no sidecar exists), clears both
 * the cached MP3 and the cached transcript before re-converting.
 *
 * @param {Object} session - Session object with sessionId
 * @param {string} localPath - Path to local audio/video file
 * @param {boolean} verbose - Whether to show ffmpeg output
 * @returns {Promise<string>} Path to the cached MP3 file
 */
export async function prepareLocalAudio(session, localPath, verbose = false) {
  const audioCachePath = getAudioCachePath(session.sessionId);
  const transcriptCachePath = getTranscriptCachePath(session.sessionId);
  const sidecarPath = `${audioCachePath}.source.json`;

  const absPath = path.resolve(localPath);
  const inputStats = fs.statSync(absPath);
  const currentFingerprint = {
    path: absPath,
    size: inputStats.size,
    mtimeMs: inputStats.mtimeMs,
  };

  // Reuse cached MP3 if the input file is unchanged since the last conversion
  if (fs.existsSync(audioCachePath) && fs.existsSync(sidecarPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
      if (cached.path === currentFingerprint.path
          && cached.size === currentFingerprint.size
          && cached.mtimeMs === currentFingerprint.mtimeMs) {
        console.log(`  Using cached MP3 conversion: ${audioCachePath}`);
        return audioCachePath;
      }
      if (verbose) {
        console.log(`    [LocalAudio] Input changed since cached conversion; re-converting`);
      }
    } catch (_) {
      // Corrupt sidecar — fall through and re-convert
    }
  }

  // Source changed or first run — clear stale audio + transcript before re-converting
  if (fs.existsSync(audioCachePath)) {
    fs.unlinkSync(audioCachePath);
    if (verbose) console.log(`    [LocalAudio] Cleared cached audio: ${audioCachePath}`);
  }
  if (fs.existsSync(transcriptCachePath)) {
    fs.unlinkSync(transcriptCachePath);
    if (verbose) console.log(`    [LocalAudio] Cleared cached transcript: ${transcriptCachePath}`);
  }
  if (fs.existsSync(sidecarPath)) {
    fs.unlinkSync(sidecarPath);
  }

  fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });

  // Convert to MP3 (arg array avoids shell injection from user-supplied path)
  console.log(`  Converting local file to MP3: ${localPath}`);
  await runProcess(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", localPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audioCachePath],
    { verbose, label: "ffmpeg convert" },
  );

  fs.writeFileSync(sidecarPath, JSON.stringify(currentFingerprint));

  if (verbose) {
    const stats = fs.statSync(audioCachePath);
    console.log(`    [LocalAudio] Converted: ${(stats.size / 1024 / 1024).toFixed(1)} MB → ${audioCachePath}`);
  }

  return audioCachePath;
}

/**
 * Prepare a local transcript file for use in the pipeline.
 * Copies the local file into the transcript cache slot so downstream stages
 * (output, build) pick it up. Clears any existing cached audio and transcript
 * for the session first so that each --transcript-file run is deterministic
 * (no stale Meetecho-derived data can shadow it).
 * @param {Object} session - Session object with sessionId
 * @param {string} localPath - Path to local transcript file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {string} The transcript text
 */
export function prepareLocalTranscript(session, localPath, verbose = false) {
  const audioCachePath = getAudioCachePath(session.sessionId);
  const transcriptCachePath = getTranscriptCachePath(session.sessionId);

  if (fs.existsSync(audioCachePath)) {
    fs.unlinkSync(audioCachePath);
    if (verbose) console.log(`    [LocalTranscript] Cleared cached audio: ${audioCachePath}`);
  }
  if (fs.existsSync(transcriptCachePath)) {
    fs.unlinkSync(transcriptCachePath);
    if (verbose) console.log(`    [LocalTranscript] Cleared cached transcript: ${transcriptCachePath}`);
  }

  const transcript = fs.readFileSync(localPath, "utf-8");
  assertTranscriptPresent(transcript, session.sessionId);

  fs.mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });
  fs.writeFileSync(transcriptCachePath, transcript);

  if (verbose) {
    console.log(`    [LocalTranscript] Wrote ${transcript.length} chars → ${transcriptCachePath}`);
  }

  return transcript;
}

/**
 * Download audio for a session (with caching)
 * @param {Object} session - Session object with sessionId
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<string>} Path to cached audio file
 */
async function downloadSessionAudio(session, verbose = false) {
  const cachePath = getAudioCachePath(session.sessionId);

  if (audioCacheExists(session.sessionId)) {
    console.log(`  Using cached audio: ${cachePath}`);
    return cachePath;
  }

  if (verbose) {
    console.log(`    [Transcribe] Fetching Cloudflare video ID for ${session.sessionId}...`);
  }
  const streamUrl = await getAudioStreamUrl(session.sessionId);
  if (verbose) {
    console.log(`    [Transcribe] Stream URL: ${streamUrl}`);
  }

  const tempPath = path.join(os.tmpdir(), `auto-minutes-${randomUUID()}.mp3`);
  try {
    console.log(`  Downloading audio...`);
    await downloadAudio(streamUrl, tempPath, verbose);

    await fsPromises.mkdir(AUDIO_CACHE_DIR, { recursive: true });
    await fsPromises.copyFile(tempPath, cachePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }

  if (verbose) {
    const stats = fs.statSync(cachePath);
    console.log(`    [Transcribe] Audio cached: ${(stats.size / 1024 / 1024).toFixed(1)} MB → ${cachePath}`);
  }

  return cachePath;
}

/**
 * Parse a "+names" hybrid suffix off an --stt-model string.
 * @param {string} sttModel - e.g. "google:chirp_3+names", "google", "gemini"
 * @returns {{baseSttModel: string, hybridNames: boolean}}
 */
export function parseSttModel(sttModel) {
  const hybridNames = sttModel.endsWith("+names");
  const baseSttModel = hybridNames ? sttModel.slice(0, -"+names".length) : sttModel;
  return { baseSttModel, hybridNames };
}

/**
 * Map generic "Speaker N" labels in a chirp transcript to real names using Gemini,
 * text-only (no audio re-upload). Fails soft: on any error, returns the transcript
 * unchanged with a warning logged, rather than failing the session.
 * @param {string} chirpTranscript - Timestamped "[HH:MM:SS] Speaker N: ..." transcript
 * @param {string} apiKey - Gemini API key
 * @param {Object|null} context - Pre-fetched session context (bluesheet used for participant names)
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, model: string}|undefined}>}
 */
export async function applyNameHybrid(chirpTranscript, apiKey, context, verbose = false) {
  try {
    const participantNames = extractParticipantNames(context?.slidesAndBluesheet?.bluesheet);
    const participantsList = participantNames.length > 0 ? participantNames.join("\n") : null;
    const usage = { inputTokens: 0, outputTokens: 0, model: "gemini-3.5-flash" };

    const rawMap = await getSpeakerMapFromGemini(apiKey, "gemini-3.5-flash", null, chirpTranscript, participantsList, verbose, usage);
    const speakerMap = normalizeSpeakerMap(rawMap);
    const text = applySpeakerMap(chirpTranscript, speakerMap);

    return { text, usage };
  } catch (error) {
    console.warn(`  Warning: speaker name mapping failed (${error.message}); keeping generic speaker labels`);
    return { text: chirpTranscript, usage: undefined };
  }
}

/**
 * Full pipeline: fetch audio stream, download (with cache), transcribe (with cache)
 * @param {Object} session - Session object with sessionId
 * @param {string} sttModel - STT model: "gemini", "google", "google:chirp_2", "google:chirp_3", "deepgram", "deepgram:nova-2", "deepgram:nova-3", or a "+names" hybrid of a diarizing backend (e.g. "google:chirp_3+names", "deepgram:nova-3+names"); chirp_2 has no diarization, so "+names" is not meaningful with it
 * @param {string} apiKey - Gemini API key (required for sttModel "gemini" or a "+names" hybrid)
 * @param {boolean} verbose - Whether to log verbose output
 * @param {Object} context - Pre-fetched session context (optional, passed to Gemini STT and the "+names" hybrid)
 * @param {string|null} localAudioPath - Path to a local audio/video file to use instead of Meetecho (optional)
 * @param {number|null} geminiSegmentSeconds - If set and sttModel is "gemini", split audio into segments of this duration before uploading (optional)
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeSession(session, sttModel, apiKey, verbose = false, context = null, localAudioPath = null, geminiSegmentSeconds = null) {
  const transcriptCachePath = getTranscriptCachePath(session.sessionId);

  // Step 1: Get audio — either convert a local file or download from Meetecho.
  // For local files we run prepareLocalAudio first; it preserves the cached
  // transcript when the input fingerprint matches the previous conversion.
  let audioPath;
  if (localAudioPath) {
    audioPath = await prepareLocalAudio(session, localAudioPath, verbose);
  }

  // Check transcript cache (valid in both branches: when localAudioPath was given,
  // prepareLocalAudio leaves the transcript intact iff it reused the cached MP3)
  if (fs.existsSync(transcriptCachePath)) {
    const cachedTranscript = await fsPromises.readFile(transcriptCachePath, "utf-8");
    try {
      assertTranscriptPresent(cachedTranscript, session.sessionId);
      console.log(`  Using cached transcript: ${transcriptCachePath}`);
      return { text: cachedTranscript, usage: { inputTokens: 0, outputTokens: 0, model: null } };
    } catch (error) {
      console.warn(`  Cached transcript for ${session.sessionId} is invalid (${error.message}); deleting and re-transcribing`);
      await fsPromises.unlink(transcriptCachePath);
    }
  }

  if (!localAudioPath) {
    audioPath = await downloadSessionAudio(session, verbose);
  }

  // Step 2: Transcribe with chosen backend
  let transcript;
  let usage;
  if (sttModel.startsWith("google")) {
    const { baseSttModel, hybridNames } = parseSttModel(sttModel);
    const chirpModel = baseSttModel.includes(":") ? baseSttModel.split(":")[1] : "chirp_3";
    console.log(`  Transcribing audio with Google Cloud STT (${chirpModel})...`);
    transcript = await transcribeAudioGoogleSTT(audioPath, chirpModel, verbose);

    if (hybridNames) {
      console.log(`  Identifying speakers with Gemini (text-only, no audio upload)...`);
      const result = await applyNameHybrid(transcript, apiKey, context, verbose);
      transcript = result.text;
      usage = result.usage;
    }
  } else if (sttModel.startsWith("deepgram")) {
    const { baseSttModel, hybridNames } = parseSttModel(sttModel);
    const deepgramModel = baseSttModel.includes(":") ? baseSttModel.split(":")[1] : "nova-3";
    const keyterms = buildDeepgramKeyterms(context);
    if (verbose) {
      console.log(`    [Transcribe] Deepgram keyterms: ${keyterms.length}`);
    }
    console.log(`  Transcribing audio with Deepgram (${deepgramModel})...`);
    transcript = await transcribeAudioDeepgram(audioPath, deepgramModel, verbose, keyterms);
    const audioSeconds = await getAudioDuration(audioPath);
    usage = { model: `deepgram:${deepgramModel}`, audioSeconds, inputTokens: 0, outputTokens: 0 };

    if (hybridNames) {
      console.log(`  Identifying speakers with Gemini (text-only, no audio upload)...`);
      const result = await applyNameHybrid(transcript, apiKey, context, verbose);
      transcript = result.text;
      // Recorded separately (rather than merged into `usage`) so the Deepgram
      // audio cost and the Gemini name-mapping token cost show as distinct
      // lines in the accounting summary instead of one clobbering the other's model.
      if (result.usage) {
        recordUsage(result.usage);
      }
    }
  } else {
    // gemini (default)
    if (geminiSegmentSeconds && geminiSegmentSeconds > 0) {
      const duration = await getAudioDuration(audioPath);
      if (duration > geminiSegmentSeconds) {
        console.log(
          `  Transcribing audio with Gemini in ${geminiSegmentSeconds}s segments (total ${Math.round(duration)}s)...`,
        );
        const segments = await splitAudio(audioPath, geminiSegmentSeconds, verbose);
        const segmentDir = path.dirname(segments[0]);
        try {
          const parts = [];
          const totalUsage = { inputTokens: 0, outputTokens: 0, model: "gemini-3.5-flash" };
          for (let i = 0; i < segments.length; i++) {
            console.log(`  Gemini STT segment ${i + 1}/${segments.length}: ${path.basename(segments[i])}`);
            const result = await transcribeAudio(segments[i], apiKey, "gemini-3.5-flash", verbose, context);
            if (!result.text || !result.text.trim()) {
              throw new Error(`Gemini STT returned no transcript text for segment ${i + 1}/${segments.length} (${path.basename(segments[i])})`);
            }
            parts.push(result.text);
            totalUsage.inputTokens += result.usage.inputTokens;
            totalUsage.outputTokens += result.usage.outputTokens;
          }
          transcript = parts.join("\n\n");
          usage = totalUsage;
        } finally {
          await fsPromises.rm(segmentDir, { recursive: true, force: true });
        }
      } else {
        console.log(
          `  Audio is ${Math.round(duration)}s (<= ${geminiSegmentSeconds}s segment); transcribing as a single piece...`,
        );
        const result = await transcribeAudio(audioPath, apiKey, "gemini-3.5-flash", verbose, context);
        transcript = result.text;
        usage = result.usage;
      }
    } else {
      console.log(`  Transcribing audio with Gemini...`);
      const result = await transcribeAudio(audioPath, apiKey, "gemini-3.5-flash", verbose, context);
      transcript = result.text;
      usage = result.usage;
    }
  }

  // For Gemini STT, apply a duration-based sanity check: a real recording
  // produces at least MIN_WORDS_PER_MINUTE words per minute of audio. This
  // runs unconditionally (unlike the official-transcript ratio check below,
  // which is skipped whenever Meetecho hasn't published a transcript yet).
  if (!sttModel.startsWith("google") && !sttModel.startsWith("deepgram")) {
    const durationMinutes = (await getAudioDuration(audioPath)) / 60;
    const audioWords = transcriptWordCount(transcript);
    const minExpectedWords = durationMinutes * MIN_WORDS_PER_MINUTE;
    if (verbose) {
      console.log(`    [Transcribe] Audio duration: ${durationMinutes.toFixed(1)} min, transcript: ${audioWords} words (minimum expected: ${Math.round(minExpectedWords)})`);
    }
    if (audioWords < minExpectedWords) {
      throw new Error(`Transcript for ${session.sessionId} has only ${audioWords} words for ${durationMinutes.toFixed(1)} minutes of audio (minimum ${Math.round(minExpectedWords)} words expected at ${MIN_WORDS_PER_MINUTE} wpm)`);
    }

    // Additional warning against the official transcript, when available.
    // Not authoritative — Meetecho may not have published it yet.
    let officialWordCount = 0;
    try {
      const officialTranscript = await downloadTranscript(session);
      officialWordCount = transcriptWordCount(officialTranscript);
      if (verbose) {
        console.log(`    [Transcribe] Official transcript: ${officialWordCount} words`);
      }
    } catch (error) {
      if (verbose) {
        console.log(`    [Transcribe] Could not fetch official transcript for comparison: ${error.message}`);
      }
    }

    if (officialWordCount > 0) {
      const ratio = audioWords / officialWordCount;
      if (verbose) {
        console.log(`    [Transcribe] Word count ratio: ${ratio.toFixed(2)} (threshold: ${TRUNCATION_RATIO_THRESHOLD})`);
      }
      if (ratio < TRUNCATION_RATIO_THRESHOLD) {
        console.warn(`  Warning: Audio transcript appears truncated (${audioWords} words vs ${officialWordCount} official, ratio ${ratio.toFixed(2)})`);
      }
    }
  }

  // Validate before caching so a failed/empty transcription can never poison the cache.
  assertTranscriptPresent(transcript, session.sessionId);

  // Save transcript to cache
  await fsPromises.mkdir(TRANSCRIPT_CACHE_DIR, { recursive: true });
  await fsPromises.writeFile(transcriptCachePath, transcript, "utf-8");
  console.log(`  Cached transcript: ${transcriptCachePath}`);

  return { text: transcript, usage };
}
