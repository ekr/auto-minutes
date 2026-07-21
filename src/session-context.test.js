import { jest } from '@jest/globals';

const mockFetchSlides = jest.fn();
const mockFetchDocuments = jest.fn();
const mockFetchPolls = jest.fn();
const mockFetchChat = jest.fn();
const mockSaveCacheMetadata = jest.fn();

jest.unstable_mockModule('./scraper.js', () => ({
  fetchSessionSlidesAndBluesheet: mockFetchSlides,
  fetchWorkingGroupDocuments: mockFetchDocuments,
  fetchSessionPolls: mockFetchPolls,
  fetchSessionChatlog: mockFetchChat,
}));

jest.unstable_mockModule('./publisher.js', () => ({
  saveCacheMetadata: mockSaveCacheMetadata,
}));

const { fetchContextForSession, saveContextMetadata, sessionSlugFromId } = await import('./session-context.js');

beforeEach(() => jest.clearAllMocks());

test('threads all fetched context through to cache metadata', async () => {
  const slidesAndBluesheet = { slides: [{ title: 'Deck' }], bluesheet: 'Alice' };
  const wgDocuments = [{ name: 'draft-example' }];
  const polls = [{ text: 'Adopt?', yes: 10, no: 2 }];
  const chat = [{ author: 'Alice', text: 'I support this.', time: '2025-11-07T09:45:00Z' }];
  mockFetchSlides.mockResolvedValue(slidesAndBluesheet);
  mockFetchDocuments.mockResolvedValue(wgDocuments);
  mockFetchPolls.mockResolvedValue(polls);
  mockFetchChat.mockResolvedValue(chat);
  mockSaveCacheMetadata.mockResolvedValue(undefined);

  const session = { sessionId: 'IETF124-CBOR-20251107-0930', sessionName: 'CBOR' };
  const context = await fetchContextForSession(session);

  expect(context).toEqual({ slidesAndBluesheet, wgDocuments, polls, chat });
  expect(mockFetchPolls).toHaveBeenCalledWith(124, session.sessionId, undefined);
  expect(mockFetchChat).toHaveBeenCalledWith(124, session.sessionId, undefined);

  await saveContextMetadata(124, session.sessionId, context);
  expect(mockSaveCacheMetadata).toHaveBeenCalledWith(124, session.sessionId, {
    slides: slidesAndBluesheet.slides,
    bluesheetText: 'Alice',
    polls,
    chat,
  });
});

test('soft-fails rejected context fetches to their empty defaults', async () => {
  mockFetchSlides.mockRejectedValue(new Error('slides unavailable'));
  mockFetchDocuments.mockRejectedValue(new Error('documents unavailable'));
  mockFetchPolls.mockRejectedValue(new Error('polls unavailable'));
  mockFetchChat.mockRejectedValue(new Error('chat unavailable'));

  await expect(fetchContextForSession({
    sessionId: 'IETF124-CBOR-20251107-0930',
    sessionName: 'CBOR',
  })).resolves.toEqual({ slidesAndBluesheet: null, wgDocuments: [], polls: [], chat: [] });
});

test.each([
  ['IETF126-6LO-20250721-0900', '6lo'],
  ['IETF112-RTG-AREA-20211108-1200', 'rtg-area'],
])('extracts %s as session slug %s', (sessionId, expected) => {
  expect(sessionSlugFromId(sessionId)).toBe(expected);
});
