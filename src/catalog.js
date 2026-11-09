import { failure, requireVideoID } from './errors.js';
import { items, continuation, header, browseSections, nodes } from './mapping.js';

export const SEARCH_PARAMS = {
  tracks: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  playlists: 'EgWKAQIoAWoKEAkQChAFEAMQBA%3D%3D',
};
function collectionParts(response) {
  const shelves = nodes(response, 'musicPlaylistShelfRenderer');
  const continuations = nodes(response, 'musicPlaylistShelfContinuation');
  const musicShelves = nodes(response, 'musicShelfRenderer');
  const contents = shelves.length ? shelves : continuations.length ? continuations : musicShelves.length ? musicShelves : response;
  return { tracks: items(contents, 'tracks', false), token: continuation(contents) };
}

export function createCatalog(client, session) {
  const searches = new Map();
  const likes = new Map();
  let likedPages;
  function clear() { searches.clear(); likes.clear(); likedPages = undefined; }
  async function paged(state, offset, fetchPage, kind, deadline) {
    if (!Number.isInteger(offset) || offset < 0) throw failure('unavailable', 'Invalid page offset.');
    while (!state.started || (state.values.length <= offset && state.token)) {
      if (Date.now() >= deadline) throw failure('unavailable', 'This page took too long to load. Try again.');
      const previous = state.token;
      const response = await fetchPage(state.token);
      const list = items(response, kind);
      const seen = new Set(state.values.map(item => item.id));
      state.values.push(...list.filter(item => !seen.has(item.id) && seen.add(item.id)));
      state.token = continuation(response);
      state.started = true;
      if (state.token === previous || (!list.length && state.token)) state.token = '';
      if (state.values.length > 5000) throw failure('unavailable', 'This collection is too large to load in one session.');
    }
    const values = state.values.slice(offset, offset + 25);
    return { [kind]: values, more: offset + values.length < state.values.length || Boolean(state.token) };
  }
  const pageState = () => ({ started: false, values: [], token: '' });
  async function search({ query, kind = 'tracks', offset = 0 }) {
    if (!SEARCH_PARAMS[kind]) throw failure('unsupported', 'YouTube Music search supports songs, albums, artists and playlists.');
    if (typeof query !== 'string' || !query.trim()) return { [kind]: [], more: false };
    const key = JSON.stringify([session.generation, query, kind]);
    if (!searches.has(key) || offset === 0) searches.set(key, pageState());
    if (searches.size > 20) searches.delete(searches.keys().next().value);
    const deadline = Date.now() + 24000;
    return paged(searches.get(key), offset, token => client.request('search', token ? { continuation: token } : { query, params: SEARCH_PARAMS[kind] }, { signed: Boolean(session.cookie), deadline }), kind, deadline);
  }
  async function browseData(id, deadline = Date.now() + 24000, signed = Boolean(session.cookie)) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw failure('unavailable', 'Invalid YouTube Music page.');
    return client.request('browse', { browseId: id }, { signed, deadline });
  }
  async function collection(id) {
    const deadline = Date.now() + 24000;
    const response = await browseData(id, deadline, id === 'VLLM' || Boolean(session.cookie));
    const initial = collectionParts(response);
    const tracks = initial.tracks;
    let token = initial.token;
    while (token) {
      if (Date.now() > deadline - 1000) throw failure('unavailable', 'This playlist is too large to load now. Try a smaller collection.');
      const next = await client.request('browse', { continuation: token }, { signed: Boolean(session.cookie), deadline });
      const part = collectionParts(next);
      tracks.push(...part.tracks);
      const nextToken = part.token;
      if (nextToken === token) throw failure('unavailable', 'YouTube Music repeated a playlist page.');
      token = nextToken;
      if (tracks.length > 5000) throw failure('unavailable', 'This playlist is too large to load.');
    }
    return { response, tracks, detail: header(response) };
  }
  async function home() {
    const response = await browseData('FEmusic_home');
    const sections = browseSections(response);
    if (!sections.length) throw failure('unavailable', 'YouTube Music returned no home sections. Try search or sign in.');
    return { title: 'YouTube Music', sections };
  }
  async function playlist({ id }) {
    const browseID = id.startsWith('VL') ? id : 'VL' + id;
    const { detail, tracks } = await collection(browseID);
    return { id, name: detail.name || 'Playlist', imageUrl: detail.imageUrl, description: detail.description, trackCount: tracks.length, tracks, fixed: browseID === 'VLLM' };
  }
  async function album({ id }) {
    const { detail, tracks } = await collection(id);
    const album = { id, name: detail.name || tracks[0]?.album.name || 'Album', imageUrl: detail.imageUrl || tracks[0]?.album.imageUrl, artists: detail.artists };
    return { album, tracks: tracks.map(track => ({ ...track, album, artists: track.artists.length ? track.artists : album.artists })) };
  }
  async function artist({ id }) {
    const response = await browseData(id);
    const detail = header(response);
    return { artist: { id, name: detail.name || 'Artist', imageUrl: detail.imageUrl }, tracks: items(response), albums: items(response, 'albums') };
  }
  async function libraryData() { return browseData('FEmusic_liked_playlists', Date.now() + 24000, true); }
  async function playlists() { return items(await libraryData(), 'playlists').map(p => ({ ...p, saved: true })); }
  async function browse({ page }) {
    if (page !== 'library') throw failure('unsupported', 'This YouTube Music page is not available.');
    const sections = browseSections(await libraryData());
    return { title: 'Library', sections: sections.length ? sections : [{ title: 'Playlists', empty: 'Your saved playlists will appear here.' }] };
  }
  async function liked({ offset = 0 }) {
    if (!session.cookie) throw failure('signIn', 'Sign in to see your liked songs.');
    if (!likedPages || offset === 0) likedPages = pageState();
    const deadline = Date.now() + 24000;
    const result = await paged(likedPages, offset, token => client.request('browse', token ? { continuation: token } : { browseId: 'VLLM' }, { signed: true, deadline }), 'tracks', deadline);
    for (const track of result.tracks) likes.set(track.id, true);
    return result;
  }
  async function isLiked({ ids }) {
    if (!session.cookie) return Object.fromEntries(ids.map(id => [id, false]));
    const unknown = ids.filter(id => !likes.has(id));
    if (unknown.length) {
      const deadline = Date.now() + 24000;
      for (let i = 0; i < unknown.length; i += 50) {
        const response = await client.request('music/get_queue', { videoIds: unknown.slice(i, i + 50) }, { signed: true, deadline });
        for (const renderer of nodes(response, 'playlistPanelVideoRenderer')) {
          const status = nodes(renderer, 'likeButtonRenderer')[0]?.likeStatus;
          const action = nodes(renderer, 'toggleMenuServiceItemRenderer').map(item => item.defaultServiceEndpoint?.likeEndpoint?.status).find(Boolean);
          if (!renderer.videoId || (!status && !action)) continue;
          likes.set(renderer.videoId, status ? status === 'LIKE' : action === 'INDIFFERENT');
        }
      }
      if (unknown.some(id => !likes.has(id))) throw failure('unavailable', 'YouTube Music did not return the liked status of this song.');
    }
    return Object.fromEntries(ids.map(id => [id, likes.get(id) === true]));
  }
  async function like({ id, on }) {
    requireVideoID(id);
    await client.request(on ? 'like/like' : 'like/removelike', { target: { videoId: id } }, { signed: true });
    likes.set(id, Boolean(on));
    likedPages = undefined;
  }
  return { clear, search, home, browse, playlist, album, artist, playlists, liked, isLiked, like };
}
