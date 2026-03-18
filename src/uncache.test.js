/**
 * Tests for --uncache functionality
 */

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import {
  deleteCachedMinutes,
  deleteCachedManifest,
  deleteCacheDir,
  getCachedSessionIds,
  saveCachedMinutes,
  saveCacheManifest,
  saveCacheMetadata,
  loadCacheManifest,
} from "./publisher.js";
import { getTranscriptCachePath, getAudioCachePath } from "./transcriber.js";

const TEST_MEETING_ID = 99999;
const TEST_SESSION_ID = "IETF99999-TESTGRP-20250101-0900";
const TEST_SESSION_ID_2 = "IETF99999-OTHER-20250101-1000";

async function createTestCache() {
  // Create minutes cache
  await saveCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID, "# Test Minutes");
  await saveCacheMetadata(TEST_MEETING_ID, TEST_SESSION_ID, { slides: [] });
  await saveCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID_2, "# Other Minutes");

  // Create manifest
  await saveCacheManifest(TEST_MEETING_ID, [
    { sessionName: "TESTGRP", sessions: [{ sessionId: TEST_SESSION_ID, recordingUrl: "http://example.com" }] },
    { sessionName: "OTHER", sessions: [{ sessionId: TEST_SESSION_ID_2, recordingUrl: "http://example.com" }] },
  ]);

  // Create transcript cache
  const transcriptPath = getTranscriptCachePath(TEST_SESSION_ID);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(transcriptPath, "transcript content", "utf-8");

  // Create audio cache
  const audioPath = getAudioCachePath(TEST_SESSION_ID);
  await fs.mkdir(path.dirname(audioPath), { recursive: true });
  await fs.writeFile(audioPath, "audio content", "utf-8");
}

async function cleanupTestCache() {
  try { await fs.rm(path.join("cache", "output", `ietf${TEST_MEETING_ID}`), { recursive: true, force: true }); } catch {}
  try { await fs.unlink(getTranscriptCachePath(TEST_SESSION_ID)); } catch {}
  try { await fs.unlink(getTranscriptCachePath(TEST_SESSION_ID_2)); } catch {}
  try { await fs.unlink(getAudioCachePath(TEST_SESSION_ID)); } catch {}
  try { await fs.unlink(getAudioCachePath(TEST_SESSION_ID_2)); } catch {}
}

afterEach(async () => {
  await cleanupTestCache();
});

describe("deleteCachedMinutes", () => {
  test("deletes minutes and metadata files", async () => {
    await createTestCache();

    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    expect(existsSync(path.join(cacheDir, TEST_SESSION_ID))).toBe(true);
    expect(existsSync(path.join(cacheDir, `${TEST_SESSION_ID}.meta.json`))).toBe(true);

    const deleted = await deleteCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID);
    expect(deleted).toBe(true);
    expect(existsSync(path.join(cacheDir, TEST_SESSION_ID))).toBe(false);
    expect(existsSync(path.join(cacheDir, `${TEST_SESSION_ID}.meta.json`))).toBe(false);
  });

  test("returns false when no files exist", async () => {
    const deleted = await deleteCachedMinutes(TEST_MEETING_ID, "NONEXISTENT");
    expect(deleted).toBe(false);
  });

  test("does not affect other sessions", async () => {
    await createTestCache();

    await deleteCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID);

    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    expect(existsSync(path.join(cacheDir, TEST_SESSION_ID_2))).toBe(true);
  });
});

describe("deleteCachedManifest", () => {
  test("deletes the manifest file", async () => {
    await createTestCache();

    const manifestPath = path.join("cache", "output", `ietf${TEST_MEETING_ID}`, ".manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const deleted = await deleteCachedManifest(TEST_MEETING_ID);
    expect(deleted).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
  });

  test("returns false when no manifest exists", async () => {
    const deleted = await deleteCachedManifest(TEST_MEETING_ID);
    expect(deleted).toBe(false);
  });
});

describe("deleteCacheDir", () => {
  test("removes empty directory", async () => {
    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    await fs.mkdir(cacheDir, { recursive: true });

    const removed = await deleteCacheDir(TEST_MEETING_ID);
    expect(removed).toBe(true);
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("does not remove non-empty directory", async () => {
    await createTestCache();

    const removed = await deleteCacheDir(TEST_MEETING_ID);
    expect(removed).toBe(false);

    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    expect(existsSync(cacheDir)).toBe(true);
  });

  test("returns false for nonexistent directory", async () => {
    const removed = await deleteCacheDir(TEST_MEETING_ID);
    expect(removed).toBe(false);
  });
});

describe("uncache integration", () => {
  test("clearing all cache types removes everything", async () => {
    await createTestCache();

    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);

    // Delete minutes for both sessions
    await deleteCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID);
    await deleteCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID_2);

    // Delete transcripts
    try { await fs.unlink(getTranscriptCachePath(TEST_SESSION_ID)); } catch {}

    // Delete audio
    try { await fs.unlink(getAudioCachePath(TEST_SESSION_ID)); } catch {}

    // Delete manifest
    await deleteCachedManifest(TEST_MEETING_ID);

    // Directory should be empty now, so deleteCacheDir should succeed
    const removed = await deleteCacheDir(TEST_MEETING_ID);
    expect(removed).toBe(true);
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("clearing only minutes preserves transcripts and audio", async () => {
    await createTestCache();

    await deleteCachedMinutes(TEST_MEETING_ID, TEST_SESSION_ID);

    // Transcript and audio should still exist
    expect(existsSync(getTranscriptCachePath(TEST_SESSION_ID))).toBe(true);
    expect(existsSync(getAudioCachePath(TEST_SESSION_ID))).toBe(true);
  });

  test("clearing only transcripts preserves minutes and audio", async () => {
    await createTestCache();

    await fs.unlink(getTranscriptCachePath(TEST_SESSION_ID));

    // Minutes and audio should still exist
    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    expect(existsSync(path.join(cacheDir, TEST_SESSION_ID))).toBe(true);
    expect(existsSync(getAudioCachePath(TEST_SESSION_ID))).toBe(true);
  });

  test("clearing only audio preserves minutes and transcripts", async () => {
    await createTestCache();

    await fs.unlink(getAudioCachePath(TEST_SESSION_ID));

    // Minutes and transcript should still exist
    const cacheDir = path.join("cache", "output", `ietf${TEST_MEETING_ID}`);
    expect(existsSync(path.join(cacheDir, TEST_SESSION_ID))).toBe(true);
    expect(existsSync(getTranscriptCachePath(TEST_SESSION_ID))).toBe(true);
  });

  test("getCachedSessionIds excludes meta files and manifest", async () => {
    await createTestCache();

    const sessionIds = await getCachedSessionIds(TEST_MEETING_ID);
    expect(sessionIds).toContain(TEST_SESSION_ID);
    expect(sessionIds).toContain(TEST_SESSION_ID_2);
    expect(sessionIds.some(id => id.includes(".meta.json"))).toBe(false);
    expect(sessionIds.some(id => id.includes(".manifest"))).toBe(false);
  });
});
