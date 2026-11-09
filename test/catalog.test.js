import { test, expect } from 'bun:test';
import { createCatalog } from '../src/catalog.js';
import { shelf, song } from './helpers.js';

// An offset follows continuation tokens and returns no repeated first-page rows.
test('search paginates and stops more at the final token', async () => {
  const calls = [];
  const catalog = createCatalog({ request: async (method, body) => {
    calls.push(body);
    return body.continuation ? shelf(['aaaaaaaaaa2']) : shelf(['aaaaaaaaaa1'], 'page2');
  } }, { cookie: '', generation: 0 });
  expect(await catalog.search({ query: 'song', kind: 'tracks' })).toMatchObject({ tracks: [{ id: 'aaaaaaaaaa1' }], more: true });
  expect(await catalog.search({ query: 'song', kind: 'tracks', offset: 1 })).toMatchObject({ tracks: [{ id: 'aaaaaaaaaa2' }], more: false });
  expect(calls[1]).toEqual({ continuation: 'page2' });
});

// Search kind and account generation each own their continuation state.
test('does not reuse another query or account continuation', async () => {
  const calls = [];
  const session = { cookie: '', generation: 0 };
  const catalog = createCatalog({ request: async (method, body) => { calls.push(body); return shelf(['aaaaaaaaaa1']); } }, session);
  await catalog.search({ query: 'one' });
  await catalog.search({ query: 'two', offset: 1 });
  session.generation++;
  await catalog.search({ query: 'one', offset: 1 });
  expect(calls.map(body => body.query)).toEqual(['one', 'two', 'one']);
});

// A playlist keeps repeats while excluding the recommendation shelf beside it.
test('collection preserves occurrences and excludes recommendations', async () => {
  const response = { contents: [
    { musicPlaylistShelfRenderer: { contents: [song('aaaaaaaaaa1'), song('aaaaaaaaaa1')] } },
    { musicCarouselShelfRenderer: { contents: [song('bbbbbbbbbb1')] } },
  ] };
  const catalog = createCatalog({ request: async () => response }, { cookie: '', generation: 0 });
  const result = await catalog.playlist({ id: 'VLtest' });
  expect(result.tracks.map(t => t.id)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa1']);
});

// Guest library and mutation actions request sign-in instead of making a fake successful change.
test('guest library calls request signed endpoints and mutations propagate auth errors', async () => {
  const catalog = createCatalog({ request: async (method, body, options) => {
    expect(options.signed).toBe(true);
    throw Object.assign(new Error('Sign in'), { code: 'signIn' });
  } }, { cookie: '', generation: 0 });
  await expect(catalog.playlists()).rejects.toMatchObject({ code: 'signIn' });
  await expect(catalog.like({ id: 'aaaaaaaaaa1', on: true })).rejects.toMatchObject({ code: 'signIn' });
  await expect(catalog.liked({ offset: 0 })).rejects.toMatchObject({ code: 'signIn' });
});

// Liked-state reads use the service's next action rather than silently treating unknown status as false.
test('isLiked decodes a remove-like action and caches confirmed mutations', async () => {
  let calls = 0;
  const catalog = createCatalog({ request: async method => {
    calls++;
    if (method.startsWith('like/')) return {};
    return { queueDatas: [{ content: { playlistPanelVideoRenderer: { videoId: 'aaaaaaaaaa1', menu: { toggleMenuServiceItemRenderer: { defaultServiceEndpoint: { likeEndpoint: { status: 'INDIFFERENT' } } } } } } }] };
  } }, { cookie: 'SAPISID=x', generation: 0 });
  expect(await catalog.isLiked({ ids: ['aaaaaaaaaa1'] })).toEqual({ aaaaaaaaaa1: true });
  await catalog.like({ id: 'aaaaaaaaaa1', on: false });
  expect(await catalog.isLiked({ ids: ['aaaaaaaaaa1'] })).toEqual({ aaaaaaaaaa1: false });
  expect(calls).toBe(2);
});

// A recommendation continuation cannot append unrelated songs to a playlist.
test('does not follow a recommendation shelf continuation', async () => {
  let calls = 0;
  const catalog = createCatalog({ request: async () => {
    calls++;
    return { contents: [
      { musicPlaylistShelfRenderer: { contents: [song('aaaaaaaaaa1')] } },
      { musicCarouselShelfRenderer: { contents: [song('bbbbbbbbbb1')], continuations: [{ nextContinuationData: { continuation: 'recommendations' } }] } },
    ] };
  } }, { cookie: '', generation: 0 });
  const result = await catalog.playlist({ id: 'VLtest' });
  expect(result.tracks.map(t => t.id)).toEqual(['aaaaaaaaaa1']);
  expect(calls).toBe(1);
});

// Album rows inherit the opened album so Now Playing can reopen its detail page.
test('album tracks carry their parent album identity', async () => {
  const catalog = createCatalog({ request: async () => ({
    header: { musicResponsiveHeaderRenderer: { title: { runs: [{ text: 'The Album' }] } } },
    contents: [{ musicShelfRenderer: { contents: [song('aaaaaaaaaa1')] } }],
  }) }, { cookie: '', generation: 0 });
  const result = await catalog.album({ id: 'MPREtest' });
  expect(result.tracks[0].album).toMatchObject({ id: 'MPREtest', name: 'The Album' });
});

