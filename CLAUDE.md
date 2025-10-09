# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**auto-minutes** - Automatically generates meeting minutes from IETF session transcripts using the Gemini API.

The tool:
1. Scrapes the IETF datatracker to find all sessions for a given meeting
2. Downloads plaintext transcripts for each session
3. Uses Gemini to generate structured meeting minutes in Markdown
4. Saves the minutes to a local directory for GitHub Pages publication

## Development Setup

```bash
# Install dependencies
npm install

# Create .env file with your Gemini API key
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# Run the tool
npm start <meeting-number>
# Example: npm start 118
```

## Project Architecture

**Node.js ES Modules** - The project uses `"type": "module"` for native ES module support.

### Module Structure

- **src/index.js** - Main entry point and orchestration
  - `processSession(session)` - Processes a single session through the full pipeline
  - `main()` - CLI entry point, handles arguments and coordinates the workflow

- **src/scraper.js** - IETF datatracker interaction
  - `fetchMeetingSessions(meetingNumber)` - Parses proceedings page to extract session info
  - `downloadTranscript(url)` - Downloads plaintext transcripts

- **src/generator.js** - Gemini API integration
  - `initializeGemini(apiKey)` - Sets up the Gemini client
  - `generateMinutes(transcript, sessionName)` - Converts transcript to Markdown minutes

- **src/publisher.js** - File system output
  - `saveMinutes(sessionName, content, outputDir)` - Writes minutes to files
  - `generateIndex(sessions, outputDir)` - Creates index.md linking all minutes

### Data Flow

1. User provides meeting number via CLI
2. Scraper fetches session list from `https://datatracker.ietf.org/meeting/<N>/proceedings`
3. For each session: download transcript → generate minutes → save to `output/`
4. Generate index page linking all minutes

### Dependencies

- `@google/generative-ai` - Gemini API client
- `cheerio` - HTML parsing for scraping
- `node-fetch` - HTTP requests
- `dotenv` - Environment variable management
