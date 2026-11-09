export function song(id = 'aaaaaaaaaa1', name = 'A song') {
  return { musicResponsiveListItemRenderer: {
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: name, navigationEndpoint: { watchEndpoint: { videoId: id } } }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
        { text: 'An artist', navigationEndpoint: { browseEndpoint: { browseId: 'UCartist', browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } },
        { text: ' • ' }, { text: '3:45' },
      ] } } },
    ],
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/image.jpg', width: 120 }] } } },
  } };
}
export function shelf(ids, token = '') {
  return { musicShelfRenderer: {
    contents: ids.map(id => song(id)),
    ...(token ? { continuations: [{ nextContinuationData: { continuation: token } }] } : {}),
  } };
}
export function direct(overrides = {}) {
  return { url: 'https://rr1---sn-test.googlevideo.com/videoplayback?expire=123', protocol: 'https', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', http_headers: { 'User-Agent': 'test', Cookie: 'secret', Authorization: 'Bearer secret' }, ...overrides };
}
export function fakeProcess(output = '', code = 0) {
  const lines = output ? output.split('\n') : [];
  return { killed: 0, waited: 0, closed: 0, write() {}, closeStdin() { this.closed++; },
    async readLine() { return lines.length ? lines.shift() : null; },
    async wait() { this.waited++; return code; }, kill() { this.killed++; },
  };
}
