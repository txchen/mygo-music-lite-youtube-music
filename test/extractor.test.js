import { test, expect } from 'bun:test';
import { createExtractor as makeExtractor, streamFromInfo, ready, FORMAT } from '../src/extractor.js';
import { direct, fakeProcess } from './helpers.js';
const readyResponse = () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]), { status: 206 });
const createExtractor = (spawn, options = {}) => makeExtractor(spawn, { fetch: async () => readyResponse(), ...options });

// Only direct audio containers from the expected CDN can reach Lite's native player.
test('accepts M4A and WebM but rejects manifests, video, local files and lookalike hosts', () => {
  expect(streamFromInfo(direct()).type).toBe('m4a');
  expect(streamFromInfo(direct({ ext: 'webm', acodec: 'opus' })).type).toBe('webm');
  for (const override of [
    { protocol: 'm3u8_native' }, { protocol: 'http_dash_segments' }, { url: 'file:///tmp/audio.m4a' },
    { url: 'https://googlevideo.com.evil.test/audio' }, { url: 'https://a.googlevideo.com/audio.m3u8' },
    { url: 'https://user:pass@a.googlevideo.com/audio' }, { ext: 'mp4' }, { acodec: 'none' }, { vcodec: 'h264' },
  ]) expect(() => streamFromInfo(direct(override))).toThrow();
});

// Account credentials cannot be copied from extraction metadata into CDN headers.
test('keeps only safe CDN headers and strips CRLF', () => {
  const result = streamFromInfo(direct({ http_headers: { Cookie: 'secret', Authorization: 'secret', 'User-Agent': 'okay', Referer: 'bad\r\nCookie: secret' } }));
  expect(result.headers).toEqual({ 'User-Agent': 'okay' });
});

// Extraction validates IDs before spawning and chooses a fresh public direct format on each play.
test('uses bounded direct extraction without cookies or shell interpolation', async () => {
  const calls = [];
  const children = [];
  const extractor = createExtractor((command, args) => {
    calls.push({ command, args });
    const child = fakeProcess(command.includes('deno') ? 'deno 2.0' : JSON.stringify(direct()));
    children.push(child);
    return child;
  });
  await expect(extractor('bad;command')).rejects.toMatchObject({ code: 'unavailable' });
  expect(calls.length).toBe(0);
  await extractor('aaaaaaaaaa1');
  await extractor('aaaaaaaaaa1');
  expect(calls.length).toBe(3);
  expect(calls[1].args).toContain(FORMAT);
  expect(calls[1].args.slice(0, 3)).toEqual(['--ignore-config', '--config-locations', '-']);
  expect(calls[1].args.join(' ')).not.toMatch(/cookie|password|ffmpeg/);
  expect(children.every(child => child.waited === 1 && child.closed === 1)).toBe(true);
});

// A blocked extractor is killed and reaped before the timeout error returns.
test('kills and reaps a timed-out child', async () => {
  let unblock;
  const child = fakeProcess();
  child.readLine = () => new Promise(resolve => { unblock = resolve; });
  child.kill = function () { this.killed++; unblock(null); };
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : child, { timeout: 20 });
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
  expect(child.killed).toBeGreaterThan(0);
  expect(child.waited).toBe(1);
});

// Excessive output cannot hold a live child or bypass the output bound.
test('kills and reaps a child exceeding output bounds', async () => {
  const child = fakeProcess('x'.repeat(2 * 1024 * 1024 + 1));
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : child);
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
  expect(child.killed).toBe(1);
  expect(child.waited).toBe(1);
});

// Setup failures and restricted public audio become actionable errors without stderr secrets.
test('reports missing dependencies, denied permissions and extractor failure', async () => {
  await expect(createExtractor(() => { throw new Error('executable not found'); })('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'setup' });
  await expect(createExtractor(() => { throw new Error('listener has not allowed programs'); })('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'setup' });
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : fakeProcess('', 1));
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
});

// A temporarily refused CDN URL is checked again before the player receives it.
test('waits for a temporarily refused direct file to become ready', async () => {
  let attempts = 0;
  let cancelled = 0;
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : fakeProcess(JSON.stringify(direct())), {
    retryDelays: [1, 2, 4],
    fetch: async (url, options) => {
      attempts++;
      expect(options.headers.Range).toBe('bytes=0-511');
      expect(options.headers.Cookie).toBeUndefined();
      expect(options.redirect).toBe('manual');
      if (attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])); },
        cancel() { cancelled++; },
      }), { status: 206 });
    },
  });
  expect((await extractor('aaaaaaaaaa1')).type).toBe('m4a');
  expect(attempts).toBe(2);
  expect(cancelled).toBe(2);
});

// A persistent refusal consumes only the remaining stream budget and never returns a broken URL.
test('bounds persistent CDN refusal by the stream deadline', async () => {
  let attempts = 0;
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : fakeProcess(JSON.stringify(direct())), {
    timeout: 30, retryDelays: [5, 10], fetch: async () => { attempts++; return new Response('', { status: 403 }); },
  });
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThan(6);
});

// Non-transient responses stop immediately and cancel their bodies rather than downloading an ignored range.
test('stops immediately on a nonretryable CDN response', async () => {
  let attempts = 0;
  let cancelled = 0;
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : fakeProcess(JSON.stringify(direct())), {
    fetch: async () => { attempts++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 200 }); },
  });
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
  expect(attempts).toBe(1);
  expect(cancelled).toBe(1);
});

// A CDN body that never produces bytes is aborted within the same total stream deadline.
test('aborts a hanging readiness response', async () => {
  let aborted = 0;
  const extractor = createExtractor(command => command.includes('deno') ? fakeProcess('deno 2.0') : fakeProcess(JSON.stringify(direct())), {
    timeout: 20, retryDelays: [1],
    fetch: async (url, options) => new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => { aborted++; controller.error(new DOMException('aborted', 'AbortError')); });
    } }), { status: 206 }),
  });
  await expect(extractor('aaaaaaaaaa1')).rejects.toMatchObject({ code: 'unavailable' });
  expect(aborted).toBe(1);
});

// A valid CDN redirect used to trigger yt-dlp instead of returning usable direct audio.
test('follows CDN and relative redirects and returns the verified final URL', async () => {
  const stream = streamFromInfo(direct());
  const calls = [];
  let cancelled = 0;
  const result = await ready(stream, async (url, options) => {
    calls.push(url);
    expect(options.redirect).toBe('manual');
    expect(options.headers.Range).toBe('bytes=0-511');
    if (calls.length < 3) return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: calls.length === 1 ? 302 : 307,
      headers: { location: calls.length === 1 ? 'https://b.googlevideo.com/first' : '/final?signature=test' },
    });
    return readyResponse();
  }, Date.now() + 1000, []);
  expect(result.url).toBe('https://b.googlevideo.com/final?signature=test');
  expect(calls.length).toBe(3);
  expect(cancelled).toBe(2);
});

// Redirects must be rejected before any request reaches an untrusted target.
test('rejects unsafe targets, absent locations and redirect loops without fetching them', async () => {
  const stream = streamFromInfo(direct());
  for (const location of ['https://evil.test/a', 'https://a.googlevideo.com.evil.test/a', 'http://a.googlevideo.com/a',
    'https://user:secret@a.googlevideo.com/a', 'https://a.googlevideo.com:444/a', 'file:///tmp/a',
    'https://a.googlevideo.com/a.m3u8', stream.url, null]) {
    let calls = 0;
    await expect(ready(stream, async () => {
      calls++;
      return new Response(null, { status: 302, headers: location ? { location } : {} });
    }, Date.now() + 1000, [])).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toBe(1);
  }
});

// A redirect chain cannot evade the request bound or container validation.
test('bounds redirect chains and rejects a final non-audio body', async () => {
  const stream = streamFromInfo(direct());
  let calls = 0;
  await expect(ready(stream, async () => new Response(null, { status: 302,
    headers: { location: `https://a.googlevideo.com/hop${++calls}` },
  }), Date.now() + 1000, [])).rejects.toMatchObject({ code: 'unavailable' });
  expect(calls).toBe(6);
  calls = 0;
  await expect(ready(stream, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: '/other' } })
    : new Response('not an audio file', { status: 206 }), Date.now() + 1000, [])).rejects.toMatchObject({ code: 'unavailable' });
  expect(calls).toBe(2);
});
