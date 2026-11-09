import { createClient } from '../src/client.js';
import { createCatalog } from '../src/catalog.js';
const session = { cookie: '', generation: 0 };
const catalog = createCatalog(createClient({ session }), session);
const home = await catalog.home();
console.log(`Home returned ${home.sections.length} sections.`);
for (const kind of ['tracks', 'albums', 'artists', 'playlists']) {
  const result = await catalog.search({ query: 'Daft Punk', kind, offset: 0 });
  if (!result[kind]?.length) throw new Error(`${kind} search returned no results.`);
  console.log(`${kind} search returned ${result[kind].length} results, more=${result.more}.`);
  if (kind === 'tracks' && result.more) {
    const next = await catalog.search({ query: 'Daft Punk', kind, offset: result.tracks.length });
    if (!next.tracks.length) throw new Error('Track search pagination returned no results.');
    console.log(`Track pagination returned ${next.tracks.length} results.`);
  }
  const first = result[kind][0];
  if (kind === 'albums') {
    const page = await catalog.album({ id: first.id });
    if (!page.tracks.length || !page.album.name) throw new Error('Album detail was empty.');
    console.log(`Album detail returned ${page.tracks.length} tracks.`);
  }
  if (kind === 'artists') {
    const page = await catalog.artist({ id: first.id });
    if (!page.artist.name || (!page.tracks.length && !page.albums.length)) throw new Error('Artist detail was empty.');
    console.log(`Artist detail returned ${page.tracks.length} tracks and ${page.albums.length} albums.`);
  }
  if (kind === 'playlists') {
    const page = await catalog.playlist({ id: first.id });
    if (!page.tracks.length || !page.name) throw new Error('Playlist detail was empty.');
    console.log(`Playlist detail returned ${page.tracks.length} tracks.`);
  }
}
console.log('Public YouTube Music smoke passed. No account credentials were used.');
