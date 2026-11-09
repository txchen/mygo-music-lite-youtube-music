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
