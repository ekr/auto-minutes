#!/usr/bin/env node

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { GoogleAuth } from "google-auth-library";
import { transcribeAudioGoogleSTT } from "./src/transcriber.js";

// Load environment variables from .env
dotenv.config();

/**
 * Helper to perform retries with exponential backoff
 */
async function retryWithBackoff(fn, retries = 3, delay = 5000, backoffFactor = 2) {
  let currentDelay = delay;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`[Retry] Attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt === retries) {
        throw error;
      }
      console.log(`[Retry] Waiting ${currentDelay / 1000}s before retrying...`);
      await new Promise(resolve => setTimeout(resolve, currentDelay));
      currentDelay *= backoffFactor;
    }
  }
}

/**
 * Verify GCP credentials and connectivity
 */
async function verifyGCPAuth(verbose = false) {
  if (verbose) console.log("Verifying GCP authentication credentials...");
  try {
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    const projectId = await auth.getProjectId();
    if (verbose) console.log(`GCP authenticated successfully. Project ID: ${projectId}`);
    return projectId;
  } catch (error) {
    throw new Error(`GCP Authentication failed. Make sure GOOGLE_APPLICATION_CREDENTIALS or gcp-key is set correctly. Error: ${error.message}`);
  }
}

/**
 * Convert the input audio file to a standard MP3 file if not already MP3.
 * Saves the output to the cache directory.
 */
function ensureMp3(inputPath, cacheDir, verbose = false) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".mp3") {
    if (verbose) console.log(`Audio file is already an MP3: ${inputPath}`);
    return inputPath;
  }

  const outputPath = path.join(cacheDir, "converted_audio.mp3");

  if (fs.existsSync(outputPath)) {
    console.log(`Reusing existing MP3 conversion: ${outputPath}`);
    return outputPath;
  }

  console.log(`Converting ${inputPath} to MP3 using ffmpeg...`);
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", outputPath],
    { stdio: verbose ? "inherit" : "ignore" }
  );

  if (result.status !== 0) {
    throw new Error(`ffmpeg conversion failed with status code ${result.status}`);
  }

  if (verbose) {
    const stats = fs.statSync(outputPath);
    console.log(`Conversion complete: ${(stats.size / 1024 / 1024).toFixed(1)} MB -> ${outputPath}`);
  }

  return outputPath;
}

/**
 * Parse the participants input (either comma-separated string or file path)
 */
async function parseParticipants(input) {
  if (!input) return null;

  try {
    if (fs.existsSync(input)) {
      const content = await fsPromises.readFile(input, "utf-8");
      return content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join("\n");
    }
  } catch (_) {
    // Treat as raw string if path check throws
  }

  return input
    .split(",")
    .map(name => name.trim())
    .filter(name => name.length > 0)
    .join("\n");
}

/**
 * Extract JSON block from a string
 */
function extractJSON(text) {
  // Try markdown block first
  const mdJsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (mdJsonMatch) {
    return JSON.parse(mdJsonMatch[1].trim());
  }

  const mdMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (mdMatch) {
    return JSON.parse(mdMatch[1].trim());
  }

  // Find braces
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not find any JSON braces in LLM response");
  }
  const jsonText = text.substring(start, end + 1);
  return JSON.parse(jsonText);
}

/**
 * Query Gemini to map generic speaker labels to actual names
 */
async function getSpeakerMapFromGemini(apiKey, modelName, file, transcript, participantsList, verbose = false) {
  const genAI = new GoogleGenerativeAI(apiKey);
  // We use low thinking level for deterministic schema-based outputs
  const genModel = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" }
    }
  });

  let prompt = `You are an expert meeting transcription assistant. You are provided with:
1. A transcription of a meeting containing generic speaker labels like "Speaker 1", "Speaker 2", etc.
`;

  if (participantsList) {
    prompt += `
2. A list of expected participants in the meeting:
${participantsList}
`;
  }

  prompt += `
Your task is to identify the actual name of each speaker (e.g. mapping "Speaker 1" to "John Doe").
- Analyze the speaker introductions, how people refer to each other, the topics discussed, and cross-reference them with the list of expected participants (if provided).
- Output ONLY a JSON object mapping each generic speaker label (exactly as written in the transcript, like "Speaker 1") to their identified real name.
- If a speaker's name cannot be identified, map them to a descriptive role (e.g. "Presenter", "Chairperson") or leave them as the original speaker label.
- Return ONLY the JSON object.

Example output format:
{
  "Speaker 1": "John Doe",
  "Speaker 2": "Jane Smith"
}
`;

  return retryWithBackoff(async () => {
    const contents = [];
    if (file) {
      contents.push({
        fileData: {
          mimeType: file.mimeType,
          fileUri: file.uri,
        },
      });
    }
    contents.push({ text: prompt + `\n\nHere is the transcript:\n${transcript}` });

    if (verbose) console.log(`Sending content generation request to Gemini (${modelName})...`);
    const result = await genModel.generateContent(contents);
    const responseText = result.response.text();

    if (verbose) console.log("Gemini raw response:\n", responseText);

    try {
      return extractJSON(responseText);
    } catch (parseError) {
      console.warn(`JSON Parse failed on primary attempt: ${parseError.message}`);
      
      // Fallback: request without JSON config constraint or with shepherding
      const fallbackModel = genAI.getGenerativeModel({ model: modelName });
      const correctionPrompt = `The previous response was not valid JSON. Extract the speaker mapping to a clean JSON object. Do not output anything but the JSON block. Here is the transcript:\n${transcript}`;
      
      const contentsFallback = [];
      if (file) {
        contentsFallback.push({
          fileData: {
            mimeType: file.mimeType,
            fileUri: file.uri,
          },
        });
      }
      contentsFallback.push({ text: correctionPrompt });
      
      const resultFallback = await fallbackModel.generateContent(contentsFallback);
      const responseTextFallback = resultFallback.response.text();
      return extractJSON(responseTextFallback);
    }
  }, 3, 5000);
}

/**
 * Normalizes speaker map keys to ensure matchability (e.g. "1" -> "Speaker 1")
 */
function normalizeSpeakerMap(speakerMap) {
  const normalized = {};
  for (const [key, value] of Object.entries(speakerMap)) {
    let normalizedKey = key.trim();
    if (/^\d+$/.test(normalizedKey)) {
      normalizedKey = `Speaker ${normalizedKey}`;
    }
    normalizedKey = normalizedKey.replace(/\*\*/g, '');
    normalized[normalizedKey] = value.trim();
  }
  return normalized;
}

/**
 * Replace generic speaker labels in the transcript with their names
 */
function applySpeakerMap(rawTranscript, speakerMap) {
  let processed = rawTranscript;
  for (const [label, name] of Object.entries(speakerMap)) {
    const escapedLabel = label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    
    // Matches "**Speaker 1**:", "**Speaker 1** :", "Speaker 1:", "Speaker 1 :"
    const regex = new RegExp(`(?:\\*\\*)?${escapedLabel}(?:\\*\\*)?\\s*:`, 'g');
    processed = processed.replace(regex, `**${name}**:`);
  }
  
  return processed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n\n') + '\n';
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 <audio-file> [options]")
    .demandCommand(1, "You must provide an audio file path.")
    .option("gcs-bucket", {
      alias: "b",
      describe: "Google Cloud Storage bucket name (overrides GCS_BUCKET env)",
      type: "string"
    })
    .option("gemini-key", {
      alias: "k",
      describe: "Gemini API key (overrides GEMINI_API_KEY env)",
      type: "string"
    })
    .option("gcp-key", {
      alias: "g",
      describe: "Path to GCP service account JSON key file (overrides GOOGLE_APPLICATION_CREDENTIALS env)",
      type: "string"
    })
    .option("chirp-model", {
      describe: "Google Cloud STT Chirp model version",
      type: "string",
      default: "chirp_3"
    })
    .option("gemini-model", {
      describe: "Gemini model version for speaker identification",
      type: "string",
      default: "gemini-3.5-flash"
    })
    .option("chirp-chunk-size", {
      describe: "Chunk size in seconds for splitting audio for Chirp",
      type: "number",
      default: 1800
    })
    .option("participants", {
      alias: "p",
      describe: "Comma-separated list of expected names or path to a file containing them",
      type: "string"
    })
    .option("no-audio-gemini", {
      describe: "Identify speakers using text transcript context only (do not upload audio to Gemini)",
      type: "boolean",
      default: false
    })
    .option("output", {
      alias: "o",
      describe: "Output path for the finalized transcript (defaults to <audio-file>.final.md)",
      type: "string"
    })
    .option("force", {
      describe: "Force re-running all stages, ignoring checkpoints",
      type: "boolean",
      default: false
    })
    .option("verbose", {
      alias: "v",
      describe: "Enable verbose/debug logging",
      type: "boolean",
      default: false
    })
    .help()
    .argv;

  const audioFile = argv._[0];
  const verbose = argv.verbose;

  // Set environment variables if supplied via command line
  if (argv.gcsBucket) process.env.GCS_BUCKET = argv.gcsBucket;
  if (argv.gcpKey) process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(argv.gcpKey);
  if (argv.geminiKey) process.env.GEMINI_API_KEY = argv.geminiKey;

  // Check required configurations
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    console.error("Error: GCS_BUCKET is required. Set it in .env or pass --gcs-bucket (-b).");
    process.exit(1);
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.error("Error: GEMINI_API_KEY is required. Set it in .env or pass --gemini-key (-k).");
    process.exit(1);
  }

  if (!fs.existsSync(audioFile)) {
    console.error(`Error: Audio file not found: ${audioFile}`);
    process.exit(1);
  }

  // Create unique cache directory based on input file path
  const absAudioPath = path.resolve(audioFile);
  const pathHash = createHash("sha256").update(absAudioPath).digest("hex").substring(0, 8);
  const baseName = path.basename(absAudioPath, path.extname(absAudioPath));
  const cacheDir = path.join("cache", "transcribe-diarize", `${baseName}-${pathHash}`);
  
  await fsPromises.mkdir(cacheDir, { recursive: true });

  const finalOutputPath = argv.output || path.join(path.dirname(absAudioPath), `${baseName}.final.md`);
  const chirpCheckPoint = path.join(cacheDir, "transcript.chirp.txt");
  const speakerMapCheckPoint = path.join(cacheDir, "speaker_map.json");

  if (argv.force) {
    if (fs.existsSync(chirpCheckPoint)) fs.unlinkSync(chirpCheckPoint);
    if (fs.existsSync(speakerMapCheckPoint)) fs.unlinkSync(speakerMapCheckPoint);
  }

  try {
    // 0. Verify GCP auth immediately
    await verifyGCPAuth(verbose);

    // 1. Convert audio if necessary
    console.log(`[Step 1] Preparing audio file...`);
    const mp3Path = ensureMp3(absAudioPath, cacheDir, verbose);

    // 2. Transcription with Chirp 3
    let rawTranscript = "";
    if (fs.existsSync(chirpCheckPoint)) {
      console.log(`[Step 2] Found cached Chirp transcript: ${chirpCheckPoint}. Skipping STT.`);
      rawTranscript = await fsPromises.readFile(chirpCheckPoint, "utf-8");
    } else {
      console.log(`[Step 2] Transcribing with Chirp 3...`);
      rawTranscript = await retryWithBackoff(async () => {
        return await transcribeAudioGoogleSTT(mp3Path, argv.chirpModel, verbose, argv.chirpChunkSize);
      }, 3, 10000);
      
      await fsPromises.writeFile(chirpCheckPoint, rawTranscript, "utf-8");
      console.log(`Saved raw Chirp transcript to checkpoint: ${chirpCheckPoint}`);
    }

    // 3. Resolve speakers with Gemini
    let speakerMap = {};
    if (fs.existsSync(speakerMapCheckPoint)) {
      console.log(`[Step 3] Found cached speaker map: ${speakerMapCheckPoint}. Skipping Gemini step.`);
      speakerMap = JSON.parse(await fsPromises.readFile(speakerMapCheckPoint, "utf-8"));
    } else {
      console.log(`[Step 3] Identifying speakers with Gemini...`);
      const participantsList = await parseParticipants(argv.participants);
      
      let geminiFile = null;
      if (!argv.noAudioGemini) {
        const fileManager = new GoogleAIFileManager(geminiApiKey);
        
        // Upload audio file to Gemini with retry
        geminiFile = await retryWithBackoff(async () => {
          console.log(`Uploading MP3 to Gemini File API...`);
          return (await fileManager.uploadFile(mp3Path, {
            mimeType: "audio/mpeg",
            displayName: path.basename(mp3Path)
          })).file;
        }, 3, 5000);
        
        console.log(`Uploaded file to Gemini: ${geminiFile.name}. Processing...`);
        
        // Wait for processing
        let retries = 0;
        const maxRetries = 30;
        while (true) {
          try {
            const file = await fileManager.getFile(geminiFile.name);
            if (file.state !== "PROCESSING") {
              if (file.state === "FAILED") {
                throw new Error("Gemini file processing failed.");
              }
              break;
            }
            if (verbose) process.stdout.write(".");
          } catch (e) {
            retries++;
            if (retries > maxRetries) throw e;
          }
          await new Promise(r => setTimeout(r, 5000));
        }
        if (verbose) console.log("\nAudio file processing complete on Gemini.");
      }

      try {
        const rawMap = await getSpeakerMapFromGemini(
          geminiApiKey,
          argv.geminiModel,
          geminiFile,
          rawTranscript,
          participantsList,
          verbose
        );
        speakerMap = normalizeSpeakerMap(rawMap);
        await fsPromises.writeFile(speakerMapCheckPoint, JSON.stringify(speakerMap, null, 2), "utf-8");
        console.log(`Saved speaker map to checkpoint: ${speakerMapCheckPoint}`);
      } finally {
        // Clean up remote file from Gemini
        if (geminiFile) {
          try {
            const fileManager = new GoogleAIFileManager(geminiApiKey);
            if (verbose) console.log(`Cleaning up Gemini remote file: ${geminiFile.name}`);
            await fileManager.deleteFile(geminiFile.name);
          } catch (err) {
            console.error(`Warning: Failed to clean up Gemini file ${geminiFile.name}: ${err.message}`);
          }
        }
      }
    }

    // 4. Generate final output transcript
    console.log(`[Step 4] Applying speaker names to transcript...`);
    const finalTranscript = applySpeakerMap(rawTranscript, speakerMap);
    
    await fsPromises.writeFile(finalOutputPath, finalTranscript, "utf-8");
    console.log(`\nSuccess! Finalized transcript written to: ${finalOutputPath}`);

  } catch (error) {
    console.error(`\nExecution failed: ${error.message}`);
    process.exit(1);
  }
}

main();
