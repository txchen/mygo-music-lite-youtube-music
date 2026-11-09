export function text(value) {
  return typeof value === 'string' ? value : value?.simpleText || (value?.runs || []).map(run => run.text || '').join('');
}
export function nodes(root, key) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value[key]) { found.push(value[key]); return; }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  }
  visit(root);
  return found;
}
export function image(value) {
  const list = nodes(value, 'thumbnails').flat();
  return list.filter(t => t?.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || '';
}
export function duration(value) {
  const match = String(value).match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return 0;
  const parts = match.slice(1).filter(x => x !== undefined).map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
}
function browseEndpoint(value) {
  return value?.navigationEndpoint?.browseEndpoint || value?.browseEndpoint;
}
function pageType(endpoint) {
  return endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
}
function credits(runs, type) {
  return runs.flatMap(run => {
    const endpoint = browseEndpoint(run);
    if (!endpoint || !pageType(endpoint).includes(type)) return [];
    return [{ id: endpoint.browseId, name: run.text || '' }];
  });
}
export function toTrack(item) {
  const columns = (item.flexColumns || []).map(c => c.musicResponsiveListItemFlexColumnRenderer?.text || {});
  const title = columns[0] || item.title || {};
  const runs = columns.slice(1).flatMap(c => c.runs || []).concat(item.subtitle?.runs || []);
  const watch = title.runs?.find(r => r.navigationEndpoint?.watchEndpoint)?.navigationEndpoint?.watchEndpoint
    || item.navigationEndpoint?.watchEndpoint || item.playlistItemData
    || nodes(item.overlay, 'watchEndpoint')[0] || {};
  const id = watch.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) return null;
  const album = credits(runs, 'ALBUM')[0] || { id: '', name: '' };
  album.imageUrl = image(item.thumbnail || item);
  const times = runs.map(r => r.text).concat((item.fixedColumns || []).map(c => text(c.musicResponsiveListItemFixedColumnRenderer?.text)));
  return {
    id, name: text(title), artists: credits(runs, 'ARTIST'), album,
    duration: times.map(duration).find(n => n > 0) || 0,
    url: `https://music.youtube.com/watch?v=${id}`,
    unavailable: item.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT',
  };
}
export function toEntity(item, kind) {
  const title = item.title || item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const endpoint = browseEndpoint(item) || title?.runs?.map(browseEndpoint).find(Boolean);
  if (!endpoint?.browseId) return null;
  const id = endpoint.browseId;
  const type = pageType(endpoint);
  if (kind === 'albums' && !type.includes('ALBUM') && !id.startsWith('MPRE')) return null;
  if (kind === 'artists' && !type.includes('ARTIST') && !id.startsWith('UC')) return null;
  if (kind === 'playlists' && !type.includes('PLAYLIST') && !id.startsWith('VL')) return null;
  const result = { id, name: text(title), imageUrl: image(item.thumbnailRenderer || item.thumbnail || item) };
  const runs = item.subtitle?.runs || item.flexColumns?.slice(1).flatMap(c => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []) || [];
  if (kind === 'albums') result.artists = credits(runs, 'ARTIST');
  if (kind === 'playlists') result.owner = credits(runs, 'USER_CHANNEL')[0]?.name || '';
  return result;
}
export function items(root, kind = 'tracks', unique = true) {
  const renderers = [...nodes(root, 'musicResponsiveListItemRenderer'), ...nodes(root, 'musicTwoRowItemRenderer')];
  const mapped = renderers.map(item => kind === 'tracks' ? toTrack(item) : toEntity(item, kind)).filter(Boolean);
  if (!unique) return mapped;
  const seen = new Set();
  return mapped.filter(item => !seen.has(item.id) && seen.add(item.id));
}
export function continuation(root) {
  const next = nodes(root, 'nextContinuationData')[0] || nodes(root, 'reloadContinuationData')[0];
  return next?.continuation || nodes(root, 'continuationCommand')[0]?.token || '';
}
export function header(root) {
  const value = nodes(root, 'musicResponsiveHeaderRenderer')[0]
    || nodes(root, 'musicDetailHeaderRenderer')[0] || nodes(root, 'musicImmersiveHeaderRenderer')[0]
    || nodes(root, 'musicVisualHeaderRenderer')[0] || {};
  return { name: text(value.title), imageUrl: image(value.thumbnail || value), description: text(value.description), artists: credits(value.subtitle?.runs || [], 'ARTIST') };
}
export function browseSections(root) {
  const shelves = [...nodes(root, 'musicCarouselShelfRenderer'), ...nodes(root, 'musicShelfRenderer'), ...nodes(root, 'musicPlaylistShelfRenderer')];
  return shelves.map(shelf => {
    const section = { title: text(shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title || shelf.title) };
    for (const kind of ['tracks', 'albums', 'artists', 'playlists']) {
      const list = items(shelf.contents || shelf, kind);
      if (list.length) section[kind] = list;
    }
    return section;
  }).filter(s => s.tracks?.length || s.albums?.length || s.artists?.length || s.playlists?.length);
}
