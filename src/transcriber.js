/**
 * Audio Transcription Module
 * Downloads session audio from Cloudflare via Meetecho and transcribes using Gemini STT
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { execSync } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { downloadTranscript } from "./scraper.js";

const AUDIO_CACHE_DIR = path.join("cache", "audio");
const TRANSCRIPT_CACHE_DIR = path.join("cache", "transcripts");

// Audio transcripts are typically ~88% of official transcript word count (based on TLS/IETF124).
// If below this ratio, the transcription was likely truncated.
const TRUNCATION_RATIO_THRESHOLD = 0.6;
const MAX_TRANSCRIPTION_ATTEMPTS = 3;

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
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
 * Get the HLS audio stream URL for a session
 * @param {string} sessionId - Meetecho session ID
 * @returns {Promise<string>} HLS stream URL
 */
export async function getAudioStreamUrl(sessionId) {
  const videoId = await fetchCloudflareVideoId(sessionId);
  return `https://videodelivery.net/${videoId}/manifest/video.m3u8`;
}

/**
 * Download audio from an HLS stream to a local MP3 file using ffmpeg
 * @param {string} streamUrl - HLS stream URL
 * @param {string} outputPath - Local file path for the MP3
 * @param {boolean} verbose - Whether to show ffmpeg output
 */
export function downloadAudio(streamUrl, outputPath, verbose = false) {
  execSync(
    `ffmpeg -hide_banner -loglevel error -i "${streamUrl}" -vn -acodec libmp3lame -q:a 2 "${outputPath}"`,
    { stdio: verbose ? "inherit" : "ignore" },
  );
}

/**
 * Transcribe an audio file using Gemini File API
 * @param {string} audioPath - Path to the audio file
 * @param {string} apiKey - Gemini API key
 * @param {string} model - Gemini model name
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, model: string}}>} Transcript text and token usage
 */
export async function transcribeAudio(audioPath, apiKey, model = "gemini-3-flash-preview", verbose = false) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  const requestOptions = { timeout: 600000 }; // 10 minutes for long audio
  const genModel = genAI.getGenerativeModel(
    { model, generationConfig: { maxOutputTokens: 65535, thinkingConfig: { thinkingLevel: "minimal" } } },
    requestOptions,
  );

  let fileName;

  try {
    if (verbose) {
      console.log(`    [Transcribe] Uploading file: ${audioPath}`);
    }

    const uploadResponse = await fileManager.uploadFile(audioPath, {
      mimeType: "audio/mpeg",
      displayName: path.basename(audioPath),
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
          process.stdout.write(".");
        }
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }
        if (verbose) {
          process.stdout.write("r");
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
    const INITIAL_PROMPT = "Please provide a complete verbatim transcript of the ENTIRE audio from start to finish. Do not stop early or summarize — transcribe every word spoken throughout the full recording. Identify speakers and label each speaker change (e.g., 'Speaker 1:', 'Speaker 2:'). If you can identify speakers by name from context, use their names instead.";
    const MAX_STREAM_RETRIES = 3;
    const allText = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, model };

    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      let prompt;
      if (attempt === 0) {
        prompt = INITIAL_PROMPT;
      } else {
        const soFar = allText.join("");
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
      let streamFailed = false;
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
              process.stdout.write(".");
            }
          }
          chunkIndex++;
        }
      } catch (streamError) {
        streamFailed = true;
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

      // Stream completed successfully
      allText.push(chunks.join(""));

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
        console.log(`\n    [Transcribe] Attempt ${attempt}: ${chunks.length} chunks, ${chunks.join("").length} chars, finishReason=${lastFinishReason}`);
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
function getAudioCachePath(sessionId) {
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
  return path.join(TRANSCRIPT_CACHE_DIR, `${sessionId}.txt`);
}

/**
 * Get audio duration in seconds using ffprobe
 * @param {string} audioPath - Path to audio file
 * @returns {number} Duration in seconds
 */
function getAudioDuration(audioPath) {
  const output = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`,
    { encoding: "utf-8" },
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
  execSync(
    `ffmpeg -hide_banner -loglevel error -i "${audioPath}" -f segment -segment_time ${segmentSeconds} -c copy "${pattern}"`,
    { stdio: verbose ? "inherit" : "ignore" },
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
 * Transcribe an audio file using Google Cloud Speech-to-Text (batch recognition)
 * Splits files longer than 30 minutes into segments and recognizes them all in one batch call.
 * @param {string} audioPath - Path to the local audio file
 * @param {string} model - STT model name (e.g., "chirp_3", "chirp_2")
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number, model: string}}|string>} Transcript text (with usage when transcription occurs, plain string from cache)
 */
export async function transcribeAudioGoogleSTT(audioPath, model = "chirp_3", verbose = false) {
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
  const duration = getAudioDuration(audioPath);
  const SEGMENT_SECONDS = 1800; // 30 minutes
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

    // Launch parallel batch recognize calls via REST
    if (verbose) {
      console.log(`    [GoogleSTT] Starting ${gcsUris.length} batch recognition(s)...`);
    }
    const token = await auth.getAccessToken();
    const opNames = await Promise.all(
      gcsUris.map(async (uri) => {
        const res = await fetch(
          `https://${restHost}/v2/${recognizer}:batchRecognize`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              config: {
                languageCodes: ["en-US"],
                model,
                autoDecodingConfig: {},
                features: model === "chirp_3" ? {
                  diarizationConfig: {},
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
      }),
    );

    for (let i = 0; i < opNames.length; i++) {
      console.log(`    [GoogleSTT] Segment ${i}: operation ${opNames[i]}`);
    }

    // Poll until all complete
    console.log(`    [GoogleSTT] Waiting for ${opNames.length} transcription(s) to complete...`);
    const startTime = Date.now();
    const completed = new Array(opNames.length).fill(false);
    const opResults = new Array(opNames.length).fill(null);

    while (completed.some(c => !c)) {
      await new Promise(resolve => setTimeout(resolve, 30000));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
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
          } else {
            const pct = data.metadata?.progressPercent || 0;
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
              let currentSpeaker = null;
              const lines = [];
              let currentLine = [];
              for (const word of alt.words) {
                if (word.speakerLabel && word.speakerLabel !== currentSpeaker) {
                  if (currentLine.length > 0) {
                    lines.push(`Speaker ${currentSpeaker}: ${currentLine.join(" ")}`);
                    currentLine = [];
                  }
                  currentSpeaker = word.speakerLabel;
                }
                currentLine.push(word.word);
              }
              if (currentLine.length > 0) {
                lines.push(`Speaker ${currentSpeaker}: ${currentLine.join(" ")}`);
              }
              transcriptParts.push(lines.join("\n"));
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
    downloadAudio(streamUrl, tempPath, verbose);

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
 * Full pipeline: fetch audio stream, download (with cache), transcribe (with cache)
 * @param {Object} session - Session object with sessionId
 * @param {string} sttModel - STT model: "gemini" or "google"
 * @param {string} apiKey - Gemini API key (required for sttModel "gemini")
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeSession(session, sttModel, apiKey, verbose = false) {
  const transcriptCachePath = getTranscriptCachePath(session.sessionId);

  // Check transcript cache first
  if (fs.existsSync(transcriptCachePath)) {
    console.log(`  Using cached transcript: ${transcriptCachePath}`);
    return await fsPromises.readFile(transcriptCachePath, "utf-8");
  }

  // Step 1: Download audio
  const audioPath = await downloadSessionAudio(session, verbose);

  // Step 2: Transcribe with chosen backend
  let transcript;
  let usage;
  if (sttModel.startsWith("google")) {
    const chirpModel = sttModel.includes(":") ? sttModel.split(":")[1] : "chirp_3";
    console.log(`  Transcribing audio with Google Cloud STT (${chirpModel})...`);
    transcript = await transcribeAudioGoogleSTT(audioPath, chirpModel, verbose);
  } else {
    // gemini (default)
    console.log(`  Transcribing audio with Gemini...`);
    const result = await transcribeAudio(audioPath, apiKey, "gemini-3-flash-preview", verbose);
    transcript = result.text;
    usage = result.usage;
  }

  // For Gemini STT, apply truncation detection with retry
  if (!sttModel.startsWith("google")) {
    // Fetch official transcript for length comparison
    let officialWordCount = 0;
    try {
      const officialTranscript = await downloadTranscript(session);
      officialWordCount = wordCount(officialTranscript);
      if (verbose) {
        console.log(`    [Transcribe] Official transcript: ${officialWordCount} words`);
      }
    } catch (error) {
      if (verbose) {
        console.log(`    [Transcribe] Could not fetch official transcript for comparison: ${error.message}`);
      }
    }

    if (officialWordCount > 0) {
      const audioWords = wordCount(transcript);
      if (verbose) {
        console.log(`    [Transcribe] Audio transcript: ${audioWords} words`);
      }
      const ratio = audioWords / officialWordCount;
      if (verbose) {
        console.log(`    [Transcribe] Word count ratio: ${ratio.toFixed(2)} (threshold: ${TRUNCATION_RATIO_THRESHOLD})`);
      }
      if (ratio < TRUNCATION_RATIO_THRESHOLD) {
        console.warn(`  Warning: Audio transcript appears truncated (${audioWords} words vs ${officialWordCount} official, ratio ${ratio.toFixed(2)})`);
      }
    }
  }

  // Save transcript to cache
  await fsPromises.mkdir(TRANSCRIPT_CACHE_DIR, { recursive: true });
  await fsPromises.writeFile(transcriptCachePath, transcript, "utf-8");
  console.log(`  Cached transcript: ${transcriptCachePath}`);

  return { text: transcript, usage };
}
