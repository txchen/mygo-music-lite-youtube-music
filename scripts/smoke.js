import { installPublicHost } from './runtime.js';
installPublicHost();
const catalog = await import('../index.js');
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
for (const page of ['charts', 'new']) {
  const result = await catalog.browse({ page });
  if (!result.sections.length) throw new Error(`${page} returned no sections.`);
  console.log(`${page} returned ${result.sections.length} sections.`);
}
const suggestions = await catalog.suggest({ query: 'Daft' });
if (!suggestions.length) throw new Error('No search suggestions.');
await catalog.played({ id: '5NV6Rdv1a3I' });
const stations = catalog.stations();
const radio = await catalog.stationNext({ id: stations[0].id });
if (!radio.length) throw new Error('No radio tracks.');
console.log(`Suggestions ${suggestions.length}, radio ${radio.length}.`);
console.log('Public YouTube Music smoke passed. No account credentials were used.');
