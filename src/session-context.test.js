import { sessionSlugFromId } from './session-context.js';

test.each([
  ['IETF126-6LO-20250721-0900', '6lo'],
  ['IETF112-RTG-AREA-20211108-1200', 'rtg-area'],
])('extracts %s as session slug %s', (sessionId, expected) => {
  expect(sessionSlugFromId(sessionId)).toBe(expected);
});
