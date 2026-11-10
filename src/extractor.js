import { failure, isFailure, requireVideoID } from './errors.js';

const PROGRAMS = ['yt-dlp', '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp'];
const RUNTIMES = ['deno', '/opt/homebrew/bin/deno', '/usr/local/bin/deno'];
export const FORMAT = 'bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/bestaudio[protocol=http]';
export function streamFromInfo(info) {
  const format = info.requested_downloads?.[0] || info;
  let url;
  try { url = new URL(format.url); } catch { throw failure('unavailable', 'YouTube did not provide a direct audio file.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.googlevideo.com') || url.username || url.password
    || !['http', 'https'].includes(format.protocol) || /\.(m3u8|mpd)(?:$|[?])/i.test(url.pathname)
    || !['m4a', 'webm'].includes(format.ext) || !format.acodec || format.acodec === 'none'
    || (format.vcodec && format.vcodec !== 'none')) {
    throw failure('unavailable', 'This item has no direct M4A or WebM audio file supported by MyGo Music Lite.');
  }
  const headers = {};
  for (const [name, value] of Object.entries(format.http_headers || info.http_headers || {})) {
    if (['user-agent', 'referer', 'origin', 'accept', 'accept-language'].includes(name.toLowerCase()) && typeof value === 'string' && !/[\r\n\0]/.test(value)) headers[name] = value;
  }
  return { url: url.href, type: format.ext, headers, ...(Number.isFinite(format.filesize) && format.filesize > 0 ? { size: format.filesize } : {}) };
}

async function run(process, deadline, limit) {
  let timer;
  let finished = false;
  let collected;
  try {
    process.closeStdin();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { process.kill(); } catch {}
        reject(failure('unavailable', 'YouTube audio extraction timed out. Try again.'));
      }, Math.max(1, deadline - Date.now()));
    });
    collected = (async () => {
      let output = '';
      let lines = 0;
      for (;;) {
        const line = await process.readLine();
        if (line === null) break;
        output += line;
        if (++lines > 16 || output.length > limit) throw failure('unavailable', 'The audio helper returned too much output. Update yt-dlp and try again.');
      }
      const code = await process.wait();
      finished = true;
      return { output, code };
    })();
    return await Promise.race([collected, timeout]);
  } finally {
    clearTimeout(timer);
    if (!finished) {
      try { process.kill(); } catch {}
      if (collected) await collected.catch(() => {});
      if (!finished) {
        // Draining after a rejected output bound lets the host reap a noisy child.
        try { while (await process.readLine() !== null) {} } catch {}
        try { await process.wait(); } catch {}
      }
    }
  }
}
// Follow only validated CDN redirects, sharing the probe's abort deadline.
async function probe(stream, fetcher, signal) {
  let url = new URL(stream.url);
  const visited = new Set();
  for (let hop = 0; hop <= 5; hop++) {
    if (visited.has(url.href)) throw failure('unavailable', 'The audio server returned a redirect loop.');
    visited.add(url.href);
    const response = await fetcher(url.href, { headers: { ...stream.headers, Range: 'bytes=0-511' }, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: url.href };
    const location = response.headers.get('location');
    try { await response.body?.cancel(); } catch {}
    if (!location || hop === 5) throw failure('unavailable', 'The audio server returned an invalid redirect.');
    let next;
    try { next = new URL(location, url); } catch { throw failure('unavailable', 'The audio server returned an invalid redirect.'); }
    if (next.protocol !== 'https:' || !next.hostname.endsWith('.googlevideo.com') || next.username || next.password
      || next.port || next.hash || /\.(m3u8|mpd)(?:$|[?])/i.test(next.pathname)) {
      throw failure('unavailable', 'The audio server redirected outside the supported audio CDN.');
    }
    url = next;
  }
}

export async function ready(stream, fetcher, deadline, retryDelays) {
  let attempt = 0;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(3000, deadline - Date.now()));
    let response;
    let retry = false;
    try {
      const checked = await probe(stream, fetcher, controller.signal);
      response = checked.response;
      if (response.status === 206) {
        const reader = response.body?.getReader();
        if (!reader) throw failure('unavailable', 'The audio server returned an unreadable response.');
        let bytes = new Uint8Array();
        try {
          while (bytes.length < 8) {
            const part = await reader.read();
            if (part.done) break;
            if (part.value.length + bytes.length > 4096) throw failure('unavailable', 'The audio server ignored a small range request.');
            const joined = new Uint8Array(bytes.length + part.value.length);
            joined.set(bytes); joined.set(part.value, bytes.length); bytes = joined;
          }
        } finally { await reader.cancel().catch(() => {}); }
        const m4a = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
        const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
        if (stream.type === 'm4a' ? m4a : webm) return { ...stream, url: checked.url };
        throw failure('unavailable', 'The audio server returned an unexpected audio container.');
      }
      retry = [403, 502, 503, 504].includes(response.status);
      if (!retry) throw failure('unavailable', `The audio server returned HTTP ${response.status}. Try another public item.`);
    } catch (error) {
      if (isFailure(error)) throw error;
      retry = true;
    } finally {
      clearTimeout(timer);
      controller.abort();
      try { await response?.body?.cancel(); } catch {}
    }
    if (!retry) break;
    if (!retryDelays.length) break;
    const delay = retryDelays[Math.min(attempt++, retryDelays.length - 1)];
    const remaining = deadline - Date.now();
    if (remaining <= delay) break;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw failure('unavailable', "YouTube's audio server is not ready or refused this public item. Try again or choose another song.");
}
function permissionError(error) { return /allow|permission/i.test(String(error)); }
export function createExtractor(spawn, { timeout = 25000, fetch: fetcher = fetch, retryDelays = [1000, 2000, 4000] } = {}) {
  let runtime;
  return async function extract(id, options = {}) {
    requireVideoID(id);
    const deadline = Math.min(Date.now() + timeout, options.deadline ?? Infinity);
    if (Date.now() >= deadline) throw failure('unavailable', 'YouTube audio extraction timed out. Try again.');
    if (!runtime) {
      for (const command of RUNTIMES) {
        let child;
        try { child = spawn(command, ['--version']); }
        catch (error) {
          if (permissionError(error)) throw failure('setup', 'Allow this plugin to run programs in Settings > Plugins, then try again.');
          continue;
        }
        const result = await run(child, deadline, 4096);
        if (result.code === 0 && /^deno\s/im.test(result.output)) { runtime = command; break; }
      }
      if (!runtime) throw failure('setup', 'Install Deno, then reopen MyGo Music Lite. See the plugin README.');
    }
    let child;
    for (const command of PROGRAMS) {
      try {
        child = spawn(command, ['--ignore-config', '--config-locations', '-', '--js-runtimes', `deno:${runtime}`, '--no-playlist', '--no-warnings', '--quiet', '--skip-download', '--dump-single-json', '--socket-timeout', '8', '--retries', '0', '--extractor-retries', '0', '--format', FORMAT, '--', `https://www.youtube.com/watch?v=${id}`]);
        break;
      } catch (error) {
        if (permissionError(error)) throw failure('setup', 'Allow this plugin to run programs in Settings > Plugins, then try again.');
      }
    }
    if (!child) throw failure('setup', 'Install yt-dlp, then reopen MyGo Music Lite. See the plugin README.');
    const { output, code } = await run(child, deadline, 2 * 1024 * 1024);
    if (code !== 0) throw failure('unavailable', 'YouTube could not provide public audio for this item. It may require an account, be restricted, or need a newer yt-dlp.');
    let info;
    try { info = JSON.parse(output); } catch { throw failure('unavailable', 'yt-dlp returned an unreadable audio response. Update yt-dlp.'); }
    return ready(streamFromInfo(info), fetcher, deadline, retryDelays);
  };
}
