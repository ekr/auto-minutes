# agents.md

This file provides comprehensive guidance for AI coding assistants working with the **auto-minutes** codebase.

## Project Overview

**auto-minutes** is a Node.js tool that automatically generates meeting minutes from IETF (Internet Engineering Task Force) session transcripts using LLM APIs (Claude or Gemini).

### Workflow

The tool operates in three distinct stages:

1. **SUMMARIZE**: Scrapes IETF datatracker → Downloads transcripts → Generates LLM summaries → Caches raw minutes
2. **OUTPUT**: Reads cached minutes → Formats with metadata → Generates markdown files for static site
3. **BUILD**: Builds static site with 11ty → Optionally prepares GitHub Pages deployment

### Key Features

- Dual LLM support (Claude Sonnet 4 or Gemini 2.5 Flash)
- Intelligent caching to avoid redundant API calls
- Multi-session aggregation (combines sessions with the same name)
- Static site generation with 11ty
- GitHub Pages deployment workflow

## Architecture

### Module Structure

```
src/
├── index.js      - Main orchestration and CLI
├── scraper.js    - IETF datatracker interaction
├── generator.js  - LLM API integration (Claude/Gemini)
└── publisher.js  - File system operations and caching
```

### Technology Stack

- **Runtime**: Node.js with ES Modules (`"type": "module"`)
- **CLI**: yargs for argument parsing
- **Web Scraping**: cheerio for HTML parsing, node-fetch for HTTP
- **LLM APIs**: @anthropic-ai/sdk, @google/generative-ai
- **Static Site**: @11ty/eleventy
- **Testing**: jest

## Module Details

### src/index.js - Main Orchestration

**Primary Functions:**

- `main()` - CLI entry point, orchestrates the three-stage workflow
- `generateSessionMinutes(meetingNumber, session)` - Generates minutes for a single session (checks cache first)
- `parseSessionId(sessionId)` - Extracts session metadata from ID format `IETFXXX-SESSIONNAME-YYYYMMDD-HHMM`
- `buildSite(preparePages)` - Builds static site with 11ty
- `copyDir(src, dest, allowedExtensions)` - Recursively copies files with extension filtering

**CLI Options:**

```bash
--summarize/-s <number>  # Generate LLM summaries for meeting
--output/-o              # Generate markdown files from cache
--build/-b               # Build site with 11ty
--pages/-p               # Build and prepare GitHub Pages
--model/-m <claude|gemini>  # Choose LLM model (default: gemini)
--verbose/-v             # Verbose output
```

**Important Patterns:**

- Sessions are grouped by `sessionName` - multiple sessions can have the same name
- Cache manifest (`.manifest.json`) tracks session groups with metadata
- The tool maintains separation between raw LLM output (cache) and formatted output (site)

### src/scraper.js - IETF Datatracker Interaction

**Key Functions:**

- `fetchMeetingSessions(meetingNumber)` - Scrapes proceedings page for session list
- `fetchMeetechoSessions(meetingNumber)` - Alternative scraper for Meetecho recordings page (not actively used)
- `downloadTranscript(session)` - Downloads plaintext transcript from Meetecho player
- `ietfFetch(url)` - Common fetch wrapper with proper User-Agent headers

**Data Format:**

Sessions are represented as:
```javascript
{
  sessionName: "6LO",
  sessionId: "IETF123-6LO-20250723-0730",
  recordingUrl: "https://meetecho-player.ietf.org/playout/?session=IETF123-6LO-20250723-0730",
  dateTime: "23 Jul 2025 07:30" // optional
}
```

**Transcript Format:**

Transcripts are JSON with timestamps:
```json
[
  {"timestamp": "00:00:15", "text": "Speaker: Hello everyone..."},
  ...
]
```

**Important Notes:**

- Uses custom User-Agent: `ietf-agenda/0.1 (+https://github.com/ekr/ietf-agenda)`
- Proceedings URL: `https://datatracker.ietf.org/meeting/{N}/proceedings`
- Transcript URL: `https://meetecho-player.ietf.org/playout/transcripts/{sessionId}`
- Handles missing transcripts gracefully (returns empty string)

### src/generator.js - LLM API Integration

**Key Functions:**

- `initializeClaude(apiKey)` - Initialize Claude client
- `initializeGemini(apiKey)` - Initialize Gemini client
- `generateMinutes(transcript, sessionName)` - Convert transcript to markdown minutes
- `cleanMarkdownCodeFence(text)` - Removes code fence markers from LLM output

**LLM Models:**

- **Claude**: `claude-sonnet-4-20250514` (max_tokens: 4096)
- **Gemini**: `gemini-2.5-flash`

**Prompt Structure:**

The prompt instructs the LLM to generate minutes with:
- `# Session Name` header
- `## Summary` - Brief overview
- `## Key Discussion Points` - Bullet points of discussion
- `## Decisions and Action Items` - If applicable
- `## Next Steps` - If applicable

**Important Notes:**

- Both APIs use the same prompt for consistency
- Output is cleaned to remove markdown code fences that some LLMs add
- Uses module-level state to track which model is initialized
- Transcripts are passed in JSON format with timestamps

### src/publisher.js - File System and Caching

**Cache Structure:**

```
cache/
└── output/
    └── ietf{N}/
        ├── .manifest.json          # Session groups metadata
        └── {sessionId}             # Raw LLM output (one per session)
```

**Output Structure:**

```
site/
├── index.md                         # Root index (generated from template)
└── minutes/
    └── ietf{N}/
        ├── index.md                 # Meeting index
        ├── {session-name}.md        # Formatted minutes (HTML version)
        └── {session-name}.txt       # Plain markdown version
```

**Key Functions:**

**Caching:**
- `cacheExists(meetingNumber, sessionId)` - Check if cached minutes exist
- `saveCachedMinutes(meetingNumber, sessionId, minutes)` - Save raw LLM output
- `getCachedMinutes(meetingNumber, sessionId)` - Load cached minutes
- `saveCacheManifest(meetingNumber, sessionGroups)` - Save session metadata
- `loadCacheManifest(meetingNumber)` - Load session metadata
- `getCachedMeetingNumbers()` - Get all cached meeting numbers

**Output:**
- `saveMinutes(sessionName, content, outputDir, recordingUrls)` - Save formatted minutes
- `generateIndex(sessions, outputDir)` - Generate meeting index page
- `generateRootIndex(destPath)` - Generate root index from template
- `sanitizeSessionName(sessionName)` - Convert session name to filename-safe string

**Important Patterns:**

- Manifest format:
  ```json
  {
    "generated": "2025-01-15T12:00:00.000Z",
    "sessionGroups": [
      {
        "sessionName": "6LO",
        "sessions": [
          {
            "sessionId": "IETF123-6LO-20250723-0730",
            "recordingUrl": "https://..."
          }
        ]
      }
    ]
  }
  ```
- Output files include header with links to markdown version and recording(s)
- Multiple sessions with same name are aggregated with separator `\n\n---\n\n`
- Session date/time is parsed from sessionId and added as header

## Development Workflow

### Setup

```bash
# Install dependencies
npm install

# Configure API key (choose one)
cp .env.example .env
# Add ANTHROPIC_API_KEY or GEMINI_API_KEY to .env
```

### Common Operations

```bash
# Generate summaries for IETF 123 (downloads + LLM)
npm start -- --summarize 123

# Use Claude instead of Gemini
npm start -- --summarize 123 --model claude

# Generate output files from cache
npm start -- --output

# Do both (summarize and output)
npm start -- --summarize 123 --output

# Build static site
npm start -- --build

# Full pipeline: summarize + output + build + prepare GitHub Pages
npm start -- --summarize 123 --output --pages

# Verbose mode
npm start -- --summarize 123 --verbose
```

### Testing

```bash
npm test
```

## Data Flow

1. **User invokes CLI** with meeting number and options
2. **SUMMARIZE STAGE** (if `--summarize`):
   - `fetchMeetingSessions()` scrapes IETF proceedings page
   - Returns array of session objects
   - Sessions grouped by `sessionName`
   - For each session:
     - Check cache with `cacheExists()`
     - If not cached: `downloadTranscript()` → `generateMinutes()` → `saveCachedMinutes()`
     - If cached: skip
   - `saveCacheManifest()` writes metadata
3. **OUTPUT STAGE** (if `--output`):
   - `getCachedMeetingNumbers()` scans cache
   - For each meeting:
     - `loadCacheManifest()` loads session groups
     - For each group:
       - Load all cached minutes with `getCachedMinutes()`
       - Parse date/time from sessionId
       - Concatenate multiple sessions
       - `saveMinutes()` writes formatted files
     - `generateIndex()` creates meeting index
   - `generateRootIndex()` creates site index
4. **BUILD STAGE** (if `--build` or `--pages`):
   - Run 11ty: `npx @11ty/eleventy`
   - If `--pages`:
     - Clone gh-pages branch
     - Reset to baseline tag
     - Copy `_site/` to `gh-pages-repo/docs/`
     - Filter by allowed extensions: `.css`, `.html`, `.txt`, `.jpg`, `.png`
     - Git add and commit

## Common Coding Tasks

### Adding a New LLM Provider

1. Add SDK to `package.json`
2. In `generator.js`:
   - Add initialization function (e.g., `initializeOpenAI()`)
   - Update `generateMinutes()` to support new model
   - Set `currentModel` appropriately
3. In `index.js`:
   - Add model choice to yargs options
   - Add API key check in main()

### Modifying the Prompt

Edit the `prompt` variable in `generator.js:generateMinutes()`. The prompt is a template literal that includes:
- Instructions for the LLM
- Session name
- Requirements (sections to include)
- Transcript data

### Changing Output Format

1. **Modify LLM output structure**: Edit prompt in `generator.js`
2. **Modify file formatting**: Edit `saveMinutes()` in `publisher.js`
3. **Modify index generation**: Edit `generateIndex()` in `publisher.js`

### Adding Metadata to Minutes

1. Parse metadata in `index.js:parseSessionId()` or similar function
2. Pass metadata through `saveMinutes()` call
3. Update `saveMinutes()` in `publisher.js` to format metadata in header

## Important Conventions

### Session Naming

- `sessionName`: Human-readable name (e.g., "6LO Working Group")
- `sessionId`: Unique identifier with format `IETFXXX-NAME-YYYYMMDD-HHMM`
- Sanitized filename: Lowercase, alphanumeric with hyphens (e.g., "6lo-working-group")

### Error Handling

- Missing transcripts are gracefully handled (return empty string, skip session)
- HTTP errors throw with descriptive messages
- File system errors should be caught and reported

### Caching Strategy

- Cache is keyed by `meetingNumber` and `sessionId`
- Cache contains raw LLM output (no formatting)
- Output stage reads cache and applies formatting
- This allows changing output format without re-running LLM

### Git Workflow for GitHub Pages

- `gh-pages` branch has a `baseline` tag
- Build process resets to baseline before copying new content
- Only specific file extensions are committed
- Uses `git@github.com:ekr/auto-minutes.git` SSH URL

## Testing

### Test Files

- `src/scraper.test.js` - Tests for scraping logic

### Running Tests

```bash
npm test
```

**Note**: Tests use Jest with experimental VM modules flag due to ES modules.

## Environment Variables

- `ANTHROPIC_API_KEY` - Required for Claude model
- `GEMINI_API_KEY` - Required for Gemini model (default)

Only one API key is required depending on which model you use.

## Static Site Generation

### 11ty Configuration

The project uses Eleventy (11ty) to convert markdown files to HTML.

- Input: `site/` directory
- Output: `_site/` directory
- Template: `templates/index.md` for root index

### Template Variables

Root index template uses a `# Meetings` section marker. The `generateRootIndex()` function:
1. Reads template from `templates/index.md`
2. Scans `cache/output/` for meeting folders
3. Generates meeting links list
4. Replaces content after `# Meetings\n` marker

## Known Issues and Considerations

1. **Cloudflare Bot Detection**: Original code included commented-out logic to use local HTML files instead of fetching from datatracker. This may be needed if Cloudflare blocks requests.

2. **Session Grouping**: Multiple sessions can have the same `sessionName` (e.g., sessions spread over multiple days). The tool aggregates these into a single output file with separators.

3. **Transcript Availability**: Not all sessions have transcripts. The tool handles missing transcripts gracefully by skipping them.

4. **API Rate Limits**: Consider implementing delays between API calls if processing many sessions to avoid rate limiting.

5. **File Extension Filtering**: GitHub Pages build only copies specific file types to avoid committing large video/audio files.

## AI Assistant Best Practices

When working with this codebase:

1. **Understand the three-stage workflow**: Don't conflate summarize, output, and build stages
2. **Check cache first**: Many operations should check cache before making API calls
3. **Preserve session grouping logic**: Multiple sessions with the same name should be aggregated
4. **Maintain ES module syntax**: Use `import/export`, not `require/module.exports`
5. **Handle missing transcripts gracefully**: Return empty strings, don't throw errors
6. **Use proper User-Agent**: IETF requests should use the custom User-Agent string
7. **Sanitize filenames**: Always use `sanitizeSessionName()` for file paths
8. **Update manifest when changing cache**: Keep `.manifest.json` in sync with cached files

## Future Enhancement Ideas

- Parallel transcript downloads/generation for faster processing
- Incremental updates (only process new sessions)
- Support for other meeting formats beyond IETF
- Better error recovery and retry logic
- Progress bars for long-running operations
- Web UI for browsing minutes
- Search functionality across all minutes
- Export to other formats (PDF, DOCX, etc.)
