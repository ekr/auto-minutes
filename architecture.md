# Architecture: auto-minutes

## Overview

auto-minutes generates IETF meeting minutes from session transcripts using an LLM. It can obtain transcripts from either the IETF datatracker (text) or Meetecho recordings (audio → STT), and also accepts locally-provided audio/video files as a recording source.

## Module Structure

```
src/
  index.js          — CLI entry point, orchestration, session resolution
  scraper.js        — IETF datatracker / Meetecho fetching
  generator.js      — LLM minutes generation (Gemini / Claude)
  transcriber.js    — Audio download, STT transcription (Gemini / Google Cloud STT / Deepgram)
  speaker-names.js  — Gemini speaker-label→name mapping (shared by transcriber.js and transcribe-diarize.js)
  publisher.js      — File system output, cache management, index generation
  accounting.js     — Token usage tracking and summary
```

## Data Flow

```
CLI args
  → session resolution (scraper.js: datatracker / Meetecho agenda)
  → per-session pipeline (index.js: generateSessionMinutes)
      → context fetch: slides, bluesheet, WG docs (scraper.js)
      → audio acquisition (transcriber.js):
          - default: download HLS stream from Meetecho via ffmpeg → cache/audio/<id>.mp3
          - --audio-file: convert local file via ffmpeg → cache/audio/<id>.mp3
      → STT transcription → cache/transcripts/<id>.md
      → LLM minutes generation (generator.js)
      → cache/minutes/<meetingId>/<id>.md
  → output: site/minutes/... markdown files
  → optional: 11ty build → _site/
```

## Key Design Decisions

### Cache layer

All intermediate artifacts are cached by `sessionId`:
- `cache/audio/<sessionId>.mp3` — downloaded/converted audio
- `cache/transcripts/<sessionId>.md` — STT transcript
- `cache/minutes/<meetingId>/<sessionId>.md` — generated minutes

Session IDs are stable IETF identifiers (e.g. `IETF124-AIPREF-20251103-1300`).

### Audio source override (`--audio-file`)

When `--audio-file <path>` is passed, `prepareLocalAudio()` in `transcriber.js` handles the override:
1. Deletes any existing cached audio and transcript for the session (ensures determinism).
2. Converts the local file to MP3 via ffmpeg (same codec as Meetecho downloads).
3. Writes the result to `cache/audio/<sessionId>.mp3`.

`transcribeSession()` then proceeds normally from that cached MP3 — the rest of the pipeline (STT, LLM, output) is unchanged.

This override requires a single-session selector (`NUMBER:GROUP` or `YYYY-MM-DD:GROUP`) and implies `--audio`.

### STT backends

Controlled via `--stt-model`:
- `google` / `google:chirp_2` / `google:chirp_3` — Google Cloud Speech-to-Text (batch, via GCS). Only `chirp_3` requests diarization + word-time-offsets, producing `[HH:MM:SS] Speaker N:` turns with real per-word timestamps and generic speaker labels; `chirp_2` has no diarization support here and returns plain undiarized text.
- `gemini` — Gemini File API (streaming with retry). Produces inline speaker names but no reliable timestamps (an LLM has no frame clock); fragile on very long (2h+) sessions due to `streamGenerateContent` drops.
- `deepgram` / `deepgram:nova-2` / `deepgram:nova-3` (default) — Deepgram prerecorded/batch API (`transcribeAudioDeepgram`, a single `POST` of the raw audio, no GCS bucket or chunking). The body is streamed from disk via `fs.createReadStream` (with an explicit `Content-Length`, recreated fresh on every retry attempt since a stream can't be resent) rather than buffered into memory, so concurrent uploads under `-j` don't accumulate large in-memory buffers and starve the event loop into GC pauses. Returns word-level timestamps and diarization in one response, formatted into the same `[HH:MM:SS] Speaker N:` shape as chirp. Keyterm boosting (`buildDeepgramKeyterms`) seeds the request with the session's bluesheet participant names and active draft names (`generator.js`'s `activeDraftNames`), deduped and capped at 100; nova-3 uses the `keyterm` query param, earlier models use `keywords`.
- `google+names` / `google:chirp_3+names` / `deepgram+names` / `deepgram:nova-3+names` — hybrid: runs the diarizing batch path above (chirp_3 or Deepgram), then makes one **text-only** Gemini call (`applyNameHybrid` in `transcriber.js`, wrapping `speaker-names.js`, no audio re-upload) to map `Speaker N` → real names using the session's bluesheet participants as context. Combines the batch backend's real timestamps/robustness with Gemini's name identification. Fails soft: if the name-mapping call errors, the session falls back to the plain `Speaker N` transcript with a warning, rather than failing. `google:chirp_2+names` is rejected at validation time — chirp_2 emits no `Speaker N:` labels, so the name-mapping step would never have anything to rename.

### Concurrency: no blocking child processes on the transcription path

Under `-j` concurrency, multiple sessions run "concurrently" on a single JS thread, so any synchronous call blocks every other session's in-flight I/O (e.g. an upload socket getting zero bytes pumped for minutes) for its full duration. All ffmpeg/ffprobe invocations in `transcriber.js` (HLS download, duration probing, segmentation, local-file conversion) therefore go through a shared `runProcess()` helper — `child_process.spawn` with an argv array (no shell) wrapped in a promise — instead of `execSync`/`spawnSync`, so the event loop stays free to service sibling sessions' STT uploads while ffmpeg/ffprobe runs.

### Minutes generation

Supports Gemini and Claude models, selected via `--model`. Context (slides, bluesheet, WG documents) is fetched before transcription so it can be used by Gemini STT for speaker identification.

### Transcript validation (defense in depth)

An empty or near-empty transcript must never reach LLM generation or publication — the LLM will otherwise confabulate minutes from context (slide titles, participant lists) with no way to tell fact from invention. Three validators live in `generator.js` (despite the name, they're the shared contract used by `scraper.js` and `transcriber.js` too, to avoid a circular import):
- `assertTranscriptPresent(transcript, sessionName)` — throws on empty/whitespace or a JSON transcript that parses to `[]`. Non-JSON (STT Markdown) is accepted without attempting to parse it.
- `transcriptWordCount(transcript)` — counts words across Meetecho JSON `{text}` entries, or falls back to plain-text splitting for STT Markdown.
- `assertTranscriptSubstantial(transcript, sessionName, {minWords, allowShort})` — word-count floor; overridable via `--allow-short-transcript` for legitimately brief sessions.

Each of the four ways a transcript can enter the pipeline validates independently, and `generateMinutes()` itself calls `assertTranscriptPresent` first (before any API call), so no caller can bypass it:
1. Gemini STT (`transcriber.js`): a stream that yields zero text is treated as a failure and retried (not silently accepted as `""`); a duration-based check (`MIN_WORDS_PER_MINUTE`) catches STT output that's non-empty but far too short for the audio length; the transcript cache is validated before every write and self-heals (deletes + re-transcribes) if a poisoned entry is found on read.
2. Meetecho text download (`scraper.js`): `downloadTranscript` rejects HTML bodies (Meetecho's not-yet-available response) and empty/all-blank JSON.
3. `--transcript-file`: validated in `prepareLocalTranscript` before it's cached.
4. Cached minutes: unaffected (already-generated text, not a transcript).

`saveMinutes()` (`publisher.js`) and the `--output` stage's transcript-copy step are additional backstops that reject empty content even if something upstream slipped through. A session that fails validation is skipped (not aborted) — `processSummarizeSessions` collects skips and prints a `SKIPPED SESSIONS` summary so automation notices instead of silently publishing a partial run.

Skips are further classified in `skip-classifier.js` (`isRecordingUnavailable`) as benign — the recording/transcript simply isn't available yet (session-info 404, no Cloudflare video, transcript below the word-count floor, or `downloadTranscript` finding no transcript published yet) — or genuine (auth/API errors, crashes, etc). `main()` (`index.js`) only sets a non-zero exit code (`shouldExitNonZero`) if at least one skip is non-benign; a run where every session was skipped for a benign reason is a legitimate no-op (e.g. the `*/15` interim-sync cron hitting a window with no recordings ready yet) and exits 0.

`isRecordingUnavailable` matches on message shape, so `downloadTranscript` (`scraper.js`) wraps failures from the shared `assertTranscriptPresent` check in its own `Transcript for X is not available yet (...)` message before they reach the classifier. This disambiguates them from the identically-worded `assertTranscriptPresent` failure that `prepareLocalTranscript` (`transcriber.js`, the `--transcript-file` path) lets through unwrapped — an empty user-supplied local file is a genuine input error, not "recording unavailable," so it must stay classified as non-benign despite sharing wording with the Meetecho case.

### Session resolution

Sessions are resolved from the IETF datatracker proceedings or Meetecho agenda. Selector formats:
- `NUMBER` — all sessions for an IETF meeting
- `NUMBER:GROUP` — single WG at a plenary
- `YYYY-MM-DD:GROUP` — interim session
- `YYYY-MM-DD` / `YYYY-MM-DD+` / `DATE-DATE` — interim date ranges
- `current` — current/upcoming meeting number via API
