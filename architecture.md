# Architecture: auto-minutes

## Overview

auto-minutes generates IETF meeting minutes from session transcripts using an LLM. It can obtain transcripts from either the IETF datatracker (text) or Meetecho recordings (audio → STT), and also accepts locally-provided audio/video files as a recording source.

## Module Structure

```
src/
  index.js        — CLI entry point, orchestration, session resolution
  scraper.js      — IETF datatracker / Meetecho fetching
  generator.js    — LLM minutes generation (Gemini / Claude)
  transcriber.js  — Audio download, STT transcription (Gemini / Google Cloud STT)
  publisher.js    — File system output, cache management, index generation
  accounting.js   — Token usage tracking and summary
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
- `google` / `google:chirp_2` / `google:chirp_3` — Google Cloud Speech-to-Text (batch, via GCS)
- `gemini` — Gemini File API (streaming with retry)

### Minutes generation

Supports Gemini and Claude models, selected via `--model`. Context (slides, bluesheet, WG documents) is fetched before transcription so it can be used by Gemini STT for speaker identification.

### Session resolution

Sessions are resolved from the IETF datatracker proceedings or Meetecho agenda. Selector formats:
- `NUMBER` — all sessions for an IETF meeting
- `NUMBER:GROUP` — single WG at a plenary
- `YYYY-MM-DD:GROUP` — interim session
- `YYYY-MM-DD` / `YYYY-MM-DD+` / `DATE-DATE` — interim date ranges
- `current` — current/upcoming meeting number via API
