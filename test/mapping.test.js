import { test, expect } from 'bun:test';
import { toTrack, items, duration, continuation, browseSections } from '../src/mapping.js';
import { song, shelf } from './helpers.js';

// A row becomes a playable track with credits, milliseconds and artwork.
test('maps song row without treating duration as artist', () => {
  const track = toTrack(song().musicResponsiveListItemRenderer);
  expect(track).toMatchObject({ id: 'aaaaaaaaaa1', name: 'A song', duration: 225000, artists: [{ id: 'UCartist', name: 'An artist' }], album: { imageUrl: 'https://i.ytimg.com/image.jpg' } });
  expect(track.url).toBe('https://music.youtube.com/watch?v=aaaaaaaaaa1');
});

// Collection callers can preserve intentional repeat occurrences of the same song.
test('preserves playlist occurrences when requested', () => {
  const response = shelf(['aaaaaaaaaa1', 'aaaaaaaaaa1', 'aaaaaaaaaa2']);
  expect(items(response).map(t => t.id)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2']);
  expect(items(response, 'tracks', false).map(t => t.id)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa1', 'aaaaaaaaaa2']);
});

// Missing video IDs and malformed time strings do not become playable IDs or durations.
test('rejects rows without video IDs and parses hour durations', () => {
  expect(toTrack({ flexColumns: [] })).toBe(null);
  expect(duration('1:02:03')).toBe(3723000);
  expect(duration('62:03')).toBe(3723000);
  expect(duration('3:99')).toBe(0);
  expect(duration('42M plays')).toBe(0);
});

// Continuation tokens and shelf contents survive the nested renderer wrapper.
test('extracts pagination token and home song section', () => {
  const response = shelf(['aaaaaaaaaa1'], 'next-page');
  expect(continuation(response)).toBe('next-page');
  expect(browseSections(response)[0].tracks[0].id).toBe('aaaaaaaaaa1');
});
