/**
 * Tests for publisher utilities
 */

import { extractDraftsFromTranscript, addInlineDraftLinks } from './publisher.js';

describe('extractDraftsFromTranscript', () => {
  test('extracts draft names from JSON transcript', () => {
    const transcript = JSON.stringify([
      { text: 'We discussed draft-ietf-foo-bar and draft-ietf-baz-qux today.' },
      { text: 'Also mentioned draft-smith-example.' },
    ]);
    const drafts = extractDraftsFromTranscript(transcript);
    expect(drafts).toContain('draft-ietf-foo-bar');
    expect(drafts).toContain('draft-ietf-baz-qux');
    expect(drafts).toContain('draft-smith-example');
    expect(drafts.length).toBe(3);
  });

  test('deduplicates draft names (case-insensitive)', () => {
    const transcript = JSON.stringify([
      { text: 'draft-ietf-foo-bar is important.' },
      { text: 'As noted, draft-ietf-foo-bar was also updated.' },
    ]);
    const drafts = extractDraftsFromTranscript(transcript);
    expect(drafts.filter(d => d === 'draft-ietf-foo-bar').length).toBe(1);
  });

  test('falls back to text search when transcript is not valid JSON', () => {
    const rawText = 'The meeting covered draft-ietf-core-link and draft-ietf-tls-rfc8446bis.';
    const drafts = extractDraftsFromTranscript(rawText);
    expect(drafts).toContain('draft-ietf-core-link');
    expect(drafts).toContain('draft-ietf-tls-rfc8446bis');
  });

  test('returns empty array when no drafts are present', () => {
    const transcript = JSON.stringify([{ text: 'No drafts were discussed.' }]);
    const drafts = extractDraftsFromTranscript(transcript);
    expect(drafts).toEqual([]);
  });

  test('returns sorted array', () => {
    const transcript = JSON.stringify([
      { text: 'draft-ietf-zzz and draft-ietf-aaa were both mentioned.' },
    ]);
    const drafts = extractDraftsFromTranscript(transcript);
    expect(drafts).toEqual([...drafts].sort());
  });
});

describe('addInlineDraftLinks', () => {
  test('linkifies a plain draft name', () => {
    const result = addInlineDraftLinks('See draft-ietf-foo-bar for details.');
    expect(result).toBe(
      'See [draft-ietf-foo-bar](https://datatracker.ietf.org/doc/draft-ietf-foo-bar/) for details.'
    );
  });

  test('strips backticks from backtick-wrapped draft names', () => {
    const result = addInlineDraftLinks('Use `draft-ietf-foo-bar` as a reference.');
    expect(result).toBe(
      'Use [draft-ietf-foo-bar](https://datatracker.ietf.org/doc/draft-ietf-foo-bar/) as a reference.'
    );
  });

  test('does not double-link an already-linked draft name', () => {
    const input = 'See [draft-ietf-foo-bar](https://datatracker.ietf.org/doc/draft-ietf-foo-bar/) for details.';
    const result = addInlineDraftLinks(input);
    // Must be identical — no nested links
    expect(result).toBe(input);
  });

  test('does not linkify draft names inside markdown link URLs', () => {
    const input = 'Details at [the spec](https://example.com/doc/draft-ietf-foo-bar/).';
    const result = addInlineDraftLinks(input);
    expect(result).toBe(input);
  });

  test('linkifies draft names outside links while preserving existing links', () => {
    const input = '[draft-ietf-existing](https://datatracker.ietf.org/doc/draft-ietf-existing/) and draft-ietf-new.';
    const result = addInlineDraftLinks(input);
    expect(result).toContain('[draft-ietf-existing](https://datatracker.ietf.org/doc/draft-ietf-existing/)');
    expect(result).toContain('[draft-ietf-new](https://datatracker.ietf.org/doc/draft-ietf-new/)');
    // Ensure the existing link isn't wrapped again
    expect(result).not.toContain('[[draft-ietf-existing]');
  });

  test('lowercases the draft name in the URL', () => {
    const result = addInlineDraftLinks('draft-IETF-Foo-Bar was discussed.');
    expect(result).toContain('https://datatracker.ietf.org/doc/draft-ietf-foo-bar/');
  });

  test('handles multiple draft names in one string', () => {
    const result = addInlineDraftLinks('draft-ietf-aaa and draft-ietf-bbb were both discussed.');
    expect(result).toContain('[draft-ietf-aaa](https://datatracker.ietf.org/doc/draft-ietf-aaa/)');
    expect(result).toContain('[draft-ietf-bbb](https://datatracker.ietf.org/doc/draft-ietf-bbb/)');
  });
});
