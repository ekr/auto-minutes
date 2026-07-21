import { jest } from '@jest/globals';

const mockFetch = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));

const {
  normalizePoll,
  fetchMeetechoPolls,
  fetchMeetechoChat,
  fetchSessionPolls,
  fetchSessionChatlog,
} = await import('./scraper.js');

describe('normalizePoll', () => {
  test('converts datatracker flat shape to normalized shape', () => {
    const flat = {
      text: 'Adopt document?',
      yes: 10,
      no: 2,
      no_opinion: 1,
      present_when_poll_closed: 15,
    };
    expect(normalizePoll(flat)).toEqual({
      text: 'Adopt document?',
      options: [
        { label: 'yes', count: 10 },
        { label: 'no', count: 2 },
        { label: 'no opinion', count: 1 },
      ],
      total: 15,
    });
  });

  test('converts Meetecho results shape to normalized shape', () => {
    const meetecho = {
      text: 'Do you support this proposal?',
      results: {
        '1': { text: null, value: 'yes', count: 20 },
        '2': { text: 'No way', value: 'no', count: 3 },
      },
      totals: 23,
    };
    expect(normalizePoll(meetecho)).toEqual({
      text: 'Do you support this proposal?',
      options: [
        { label: 'yes', count: 20 },
        { label: 'No way', count: 3 },
      ],
      total: 23,
    });
  });

  test('returns null if text is missing or empty', () => {
    expect(normalizePoll({ text: '' })).toBeNull();
    expect(normalizePoll(null)).toBeNull();
  });
});

describe('fetchMeetechoPolls', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('returns normalized polls on a mocked 200 array response', async () => {
    const meetechoPolls = [
      {
        text: 'Problem statement clear?',
        results: {
          '1': { value: 'yes', count: 18 },
          '2': { value: 'no', count: 2 },
        },
        totals: 20,
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(meetechoPolls),
    });

    const result = await fetchMeetechoPolls('IETF126-CURRENT-20260721-1430');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://meetecho-player.ietf.org/playout/polls/IETF126-CURRENT-20260721-1430',
      expect.any(Object)
    );
    expect(result).toEqual([
      {
        text: 'Problem statement clear?',
        options: [
          { label: 'yes', count: 18 },
          { label: 'no', count: 2 },
        ],
        total: 20,
      },
    ]);
  });

  test('returns [] on a 404 body or error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await fetchMeetechoPolls('IETF126-NONEXISTENT-20260721-1430');
    expect(result).toEqual([]);
  });
});

describe('fetchMeetechoChat', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('maps messages[] to {author, text (HTML stripped), time} using start_datetime + dtime', async () => {
    const sessionData = {
      start_datetime: '2026-07-21T14:30:00.000Z',
      messages: [
        {
          author: 'Alice',
          text: '<p>Hello <span class="emoji" title="wave">:wave:</span></p>',
          dtime: 60000,
        },
      ],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(sessionData),
    });

    const result = await fetchMeetechoChat('IETF126-CURRENT-20260721-1430');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://meetecho-player.ietf.org/playout/sessions/IETF126-CURRENT-20260721-1430',
      expect.any(Object)
    );
    expect(result).toEqual([
      {
        author: 'Alice',
        text: 'Hello :wave:',
        time: '2026-07-21T14:31:00.000Z',
      },
    ]);
  });

  test('returns [] on failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const result = await fetchMeetechoChat('IETF126-NONEXISTENT');
    expect(result).toEqual([]);
  });
});

describe('Datatracker fallback to Meetecho', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  test('fetchSessionPolls falls back to Meetecho when datatracker returns 404/empty', async () => {
    // 1. Datatracker materials URL returns 404
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    // 2. Datatracker doc search returns empty objects
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ objects: [] }),
    });
    // 3. Meetecho polls endpoint returns 200 with poll
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify([
          {
            text: 'Meetecho poll?',
            results: { '1': { value: 'yes', count: 5 } },
            totals: 5,
          },
        ]),
    });

    const polls = await fetchSessionPolls(126, 'IETF126-CURRENT-20260721-1430');
    expect(polls).toEqual([
      {
        text: 'Meetecho poll?',
        options: [{ label: 'yes', count: 5 }],
        total: 5,
      },
    ]);
    expect(mockFetch.mock.calls[0][0]).toContain('datatracker.ietf.org/meeting/126/materials/polls-126-current');
    expect(mockFetch.mock.calls[2][0]).toBe(
      'https://meetecho-player.ietf.org/playout/polls/IETF126-CURRENT-20260721-1430'
    );
  });

  test('fetchSessionPolls does NOT call Meetecho when datatracker returns data', async () => {
    // Datatracker returns polls JSON
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify([
          { text: 'Datatracker poll', yes: 10, no: 1, present_when_poll_closed: 11 },
        ]),
    });

    const polls = await fetchSessionPolls(124, 'IETF124-CBOR-20251107-0930');
    expect(polls).toEqual([
      {
        text: 'Datatracker poll',
        options: [
          { label: 'yes', count: 10 },
          { label: 'no', count: 1 },
        ],
        total: 11,
      },
    ]);
    // Meetecho endpoint should not have been called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('datatracker.ietf.org');
  });

  test('fetchSessionChatlog falls back to Meetecho when datatracker returns 404/empty', async () => {
    // 1. Datatracker materials URL returns 404
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });
    // 2. Datatracker doc search returns empty objects
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ objects: [] }),
    });
    // 3. Meetecho session endpoint returns 200 with chat
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          start_datetime: '2026-07-21T14:30:00.000Z',
          messages: [{ author: 'Bob', text: 'Meetecho chat', dtime: 1000 }],
        }),
    });

    const chat = await fetchSessionChatlog(126, 'IETF126-CURRENT-20260721-1430');
    expect(chat).toEqual([
      { author: 'Bob', text: 'Meetecho chat', time: '2026-07-21T14:30:01.000Z' },
    ]);
    expect(mockFetch.mock.calls[2][0]).toBe(
      'https://meetecho-player.ietf.org/playout/sessions/IETF126-CURRENT-20260721-1430'
    );
  });
});
