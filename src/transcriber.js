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
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeAudio(audioPath, apiKey, model = "gemini-3.1-pro-preview", verbose = false) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const fileManager = new GoogleAIFileManager(apiKey);
  const requestOptions = { timeout: 600000 }; // 10 minutes for long audio
  const genModel = genAI.getGenerativeModel(
    { model, generationConfig: { maxOutputTokens: 65535 } },
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

    // Use streaming to avoid fetch timeout on long audio
    const streamResult = await genModel.generateContentStream([
      {
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      },
      {
        text: "Please provide a complete verbatim transcript of the ENTIRE audio from start to finish. Do not stop early or summarize — transcribe every word spoken throughout the full recording. Identify speakers and label each speaker change (e.g., 'Speaker 1:', 'Speaker 2:'). If you can identify speakers by name from context, use their names instead.",
      },
    ]);

    const chunks = [];
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        chunks.push(text);
        if (verbose) {
          process.stdout.write(".");
        }
      }
    }
    const transcript = chunks.join("");
    if (verbose) {
      console.log(`\n    [Transcribe] Transcript: ${chunks.length} chunks, ${transcript.length} chars`);
    }
    return transcript;
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
function getTranscriptCachePath(sessionId) {
  return path.join(TRANSCRIPT_CACHE_DIR, `${sessionId}.txt`);
}

/**
 * Full pipeline: fetch audio stream, download (with cache), transcribe (with cache)
 * @param {Object} session - Session object with sessionId
 * @param {string} apiKey - Gemini API key
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<string>} Transcript text
 */
export async function transcribeSession(session, apiKey, verbose = false) {
  const transcriptCachePath = getTranscriptCachePath(session.sessionId);

  // Check transcript cache first
  if (fs.existsSync(transcriptCachePath)) {
    console.log(`  Using cached transcript: ${transcriptCachePath}`);
    return await fsPromises.readFile(transcriptCachePath, "utf-8");
  }

  const cachePath = getAudioCachePath(session.sessionId);

  // Step 1: Get audio (from cache or download)
  if (audioCacheExists(session.sessionId)) {
    console.log(`  Using cached audio: ${cachePath}`);
  } else {
    // Get the audio stream URL
    if (verbose) {
      console.log(`    [Transcribe] Fetching Cloudflare video ID for ${session.sessionId}...`);
    }
    const streamUrl = await getAudioStreamUrl(session.sessionId);
    if (verbose) {
      console.log(`    [Transcribe] Stream URL: ${streamUrl}`);
    }

    // Download to a temp file first, then move to cache (atomic)
    const tempPath = path.join(os.tmpdir(), `auto-minutes-${randomUUID()}.mp3`);
    try {
      console.log(`  Downloading audio...`);
      downloadAudio(streamUrl, tempPath, verbose);

      // Move to cache
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
  }

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

  // Step 2: Transcribe from cached file, with truncation detection
  let transcript;
  for (let attempt = 1; attempt <= MAX_TRANSCRIPTION_ATTEMPTS; attempt++) {
    console.log(`  Transcribing audio with Gemini${attempt > 1 ? ` (attempt ${attempt})` : ""}...`);
    transcript = await transcribeAudio(cachePath, apiKey, "gemini-3.1-pro-preview", verbose);

    const audioWords = wordCount(transcript);
    if (verbose) {
      console.log(`    [Transcribe] Audio transcript: ${audioWords} words`);
    }

    if (officialWordCount > 0) {
      const ratio = audioWords / officialWordCount;
      if (verbose) {
        console.log(`    [Transcribe] Word count ratio: ${ratio.toFixed(2)} (threshold: ${TRUNCATION_RATIO_THRESHOLD})`);
      }
      if (ratio >= TRUNCATION_RATIO_THRESHOLD || attempt >= MAX_TRANSCRIPTION_ATTEMPTS) {
        if (ratio < TRUNCATION_RATIO_THRESHOLD) {
          console.warn(`  Warning: Audio transcript appears truncated (${audioWords} words vs ${officialWordCount} official, ratio ${ratio.toFixed(2)})`);
        }
        break;
      }
      console.warn(`  Audio transcript appears truncated (${audioWords} words vs ${officialWordCount} official, ratio ${ratio.toFixed(2)}). Retrying...`);
    } else {
      break;
    }
  }

  // Save transcript to cache
  await fsPromises.mkdir(TRANSCRIPT_CACHE_DIR, { recursive: true });
  await fsPromises.writeFile(transcriptCachePath, transcript, "utf-8");
  console.log(`  Cached transcript: ${transcriptCachePath}`);

  return transcript;
}
