import { test, expect } from 'bun:test';
import { fakeProcess } from './helpers.js';

const audioURL = 'https://rr1---sn-test.googlevideo.com/videoplayback';
function container() { return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 206 }); }
async function withPlugin(run, initial = {}) {
  const originalHost = globalThis.host;
  const originalFetch = globalThis.fetch;
  const storage = new Map(Object.entries(initial));
  const calls = [];
  const processes = [];
  let fetcher = async () => Response.json({});
  let signingIn;
  globalThis.host = {
    t: text => text, language: () => 'en', platform: 'darwin',
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    webSignIn: options => { calls.push(options); return new Promise(resolve => { signingIn = resolve; }); },
    spawn(command, args) {
      processes.push({ command, args });
      return fakeProcess(command.includes('deno') ? 'deno 2.0' : JSON.stringify({ url: audioURL, protocol: 'https', ext: 'm4a', acodec: 'aac', vcodec: 'none' }));
    },
  };
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url, ...options });
    return fetcher(url, options);
  };
  try {
    const plugin = await import(`../src/index.js?test=${crypto.randomUUID()}`);
    await run({ plugin, storage, calls, processes, fetch: fn => { fetcher = fn; }, finishSignIn: cookie => signingIn({ cookie }) });
  } finally { globalThis.host = originalHost; globalThis.fetch = originalFetch; }
}

// The Lite port used to omit upstream discovery, lyrics, history and radio entry points entirely.
test('retains every upstream export and navigation destination', async () => {
  await withPlugin(async ({ plugin }) => {
    expect(Object.keys(plugin).sort()).toEqual(['account', 'album', 'artist', 'browse', 'home', 'isLiked', 'like', 'liked', 'lyrics', 'played', 'playlist', 'playlists', 'recent', 'search', 'signIn', 'signOut', 'stationNext', 'stations', 'stream', 'suggest'].sort());
    const manifest = await Bun.file(new URL('../plugin.json', import.meta.url)).json();
    expect(manifest.navigation.map(item => item.builtin || item.page)).toEqual(['home', 'charts', 'new', 'stations', 'liked']);
    expect(manifest.permissions.process.some(program => program.includes('ffmpeg'))).toBe(false);
  });
});

// Updating from the independent Lite release must retain its local account and remove both session keys on sign-out.
test('migrates the existing session without losing login and clears it on sign-out', async () => {
  await withPlugin(async ({ plugin, storage, fetch }) => {
    expect(storage.get('cookie')).toBe('SAPISID=old');
    fetch(async (url, options) => {
      expect(options.headers.cookie).toBe('SAPISID=old');
      return Response.json({ activeAccountHeaderRenderer: { accountName: { simpleText: 'Old account' }, channelHandle: { simpleText: '@old' } } });
    });
    expect(await plugin.account()).toMatchObject({ id: '@old' });
    plugin.signOut();
    expect(storage.has('cookie')).toBe(false);
    expect(storage.has('session')).toBe(false);
    expect(await plugin.account()).toBe(null);
  }, { session: { cookie: 'SAPISID=old', account: { id: '@old' } } });
});

// A delayed Google browser result must not restore credentials after the user signs out.
test('keeps the original browser handoff and rejects a sign-in cancelled by sign-out', async () => {
  await withPlugin(async ({ plugin, calls, storage, finishSignIn }) => {
    const pending = plugin.signIn();
    expect(calls[0].userAgent).toContain('Version/18.5 Safari/605.1.15');
    expect(calls[0].until).toEqual(['SAPISID', '__Secure-3PSID']);
    expect(new URL(new URL(calls[0].url).searchParams.get('continue')).pathname).toBe('/signin');
    plugin.signOut();
    finishSignIn('SAPISID=new');
    await expect(pending).rejects.toMatchObject({ code: 'signIn' });
    expect(storage.has('cookie')).toBe(false);
  });
});

// A ready VISIONOS address should open directly and use its cache without starting an audio helper.
test('prefers direct AAC, retains gain and validates cached addresses without spawning', async () => {
  await withPlugin(async ({ plugin, fetch, processes, calls }) => {
    fetch(async (url, options) => {
      if (url === audioURL) return container();
      if (url.includes('/visitor_id?')) return Response.json({ responseContext: { visitorData: 'visitor-test' } });
      expect(options.headers.cookie).toBeUndefined();
      expect(JSON.parse(options.body).context.client.clientName).toBe('VISIONOS');
      return Response.json({ playabilityStatus: { status: 'OK' }, playerConfig: { audioConfig: { trackAbsoluteLoudnessLkfs: -12 } }, streamingData: { adaptiveFormats: [
        { url: audioURL, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
        { url: audioURL, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000 },
      ] } });
    });
    expect(await plugin.stream({ id: 'aaaaaaaaaa1' })).toMatchObject({ url: audioURL, type: 'm4a', gain: -6, bitRate: 128000 });
    expect((await plugin.stream({ id: 'aaaaaaaaaa1' })).type).toBe('m4a');
    expect(calls.filter(call => call.url.includes('/player?')).length).toBe(1);
    expect(calls.filter(call => call.url === audioURL).length).toBe(2);
    expect(processes.length).toBe(0);
  }, { cookie: 'SAPISID=private' });
});

// An address can expire before its cached lifetime and must be replaced rather than handed to the player.
test('refreshes stale cached direct addresses and falls back when a fresh direct address is refused', async () => {
  await withPlugin(async ({ plugin, fetch, processes }) => {
    let playerCalls = 0;
    let refuses = false;
    fetch(async url => {
      if (url === audioURL) {
        if (refuses) { refuses = false; return new Response('', { status: 403 }); }
        return container();
      }
      if (url.includes('/visitor_id?')) return Response.json({ responseContext: { visitorData: 'visitor' } });
      playerCalls++;
      if (playerCalls === 3) refuses = true;
      return Response.json({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [{ url: audioURL, mimeType: 'audio/mp4', bitrate: 128000 }] } });
    });
    await plugin.stream({ id: 'aaaaaaaaaa1' });
    refuses = true;
    await plugin.stream({ id: 'aaaaaaaaaa1' });
    expect(playerCalls).toBe(2);
    expect(processes.length).toBe(0);
    expect((await plugin.stream({ id: 'bbbbbbbbbb1' })).type).toBe('m4a');
    expect(processes.some(process => process.command.includes('yt-dlp'))).toBe(true);
  });
});

// Radio uses the locally played seed while unsigned playback cannot mutate an account's remote history.
test('persists public played seed and uses it for radio without reporting history', async () => {
  await withPlugin(async ({ plugin, storage, fetch, calls }) => {
    await plugin.played({ id: 'aaaaaaaaaa1' });
    expect(storage.get('lastPlayed')).toBe('aaaaaaaaaa1');
    expect(calls.length).toBe(0);
    fetch(async (url, options) => {
      expect(JSON.parse(options.body)).toMatchObject({ videoId: 'aaaaaaaaaa1', playlistId: 'RDAMVMaaaaaaaaaa1' });
      return Response.json({ playlistPanelVideoRenderer: { videoId: 'bbbbbbbbbb1', title: { simpleText: 'Next' }, lengthText: { simpleText: '3:00' } } });
    });
    expect((await plugin.stations())[0].id).toBe('radio');
    expect((await plugin.stationNext())[0]).toMatchObject({ id: 'bbbbbbbbbb1', duration: 180000 });
  });
});

// The original timed and word-timed lyric paths must survive the native audio port.
test('returns original YouTube timed lyrics when Better Lyrics has no match', async () => {
  await withPlugin(async ({ plugin, fetch }) => {
    fetch(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(body.context.client.clientName).toBe('ANDROID_MUSIC');
      if (url.includes('/next?')) return Response.json({ browseId: 'MPLY-test' });
      return Response.json({ timedLyricsData: [{ lyricLine: 'A timed line', cueRange: { startTimeMilliseconds: '1200', endTimeMilliseconds: '2400' } }] });
    });
    expect(await plugin.lyrics({ id: 'aaaaaaaaaa1' })).toEqual({ lines: [{ start: 1200, end: 2400, text: 'A timed line' }] });
  });
});

// Signed in, lyrics came back empty: the Android client was sent the website's
// cookie and SAPISIDHASH, which YouTube answers with a 400.
test('asks for lyrics without the signed-in session', async () => {
  await withPlugin(async ({ plugin, storage, fetch }) => {
    fetch(async (url, options) => {
      if (options.headers.cookie || options.headers.authorization) return new Response('', { status: 400 });
      if (url.includes('/next?')) return Response.json({ browseId: 'MPLY-test' });
      return Response.json({ timedLyricsData: [{ lyricLine: 'A timed line', cueRange: { startTimeMilliseconds: '1200', endTimeMilliseconds: '2400' } }] });
    });
    expect(await plugin.lyrics({ id: 'aaaaaaaaaa1' })).toEqual({ lines: [{ start: 1200, end: 2400, text: 'A timed line' }] });
    expect(storage.get('cookie')).toBe('SAPISID=private');
  }, { cookie: 'SAPISID=private' });
});

// An old account response, including HTTP 401, must not erase a newer successful sign-in.
test('rejects an old account response without clearing a newer session', async () => {
  await withPlugin(async ({ plugin, storage, fetch, finishSignIn }) => {
    let completeOld;
    fetch(async (url, options) => {
      if (options.headers.cookie === 'SAPISID=old') return new Promise(resolve => { completeOld = resolve; });
      return Response.json({ activeAccountHeaderRenderer: { accountName: { simpleText: 'New account' }, channelHandle: { simpleText: '@new' } } });
    });
    const old = plugin.account();
    const next = plugin.signIn();
    finishSignIn('SAPISID=new');
    expect(await next).toMatchObject({ id: '@new' });
    completeOld(new Response('', { status: 401 }));
    await expect(old).rejects.toMatchObject({ code: 'signIn' });
    expect(storage.get('cookie')).toBe('SAPISID=new');
  }, { cookie: 'SAPISID=old' });
});

// An anonymous audio refusal has no authority to end a signed-in catalog session.
test('falls back after anonymous 401 without signing out and retries malformed native candidates', async () => {
  await withPlugin(async ({ plugin, storage, fetch, processes }) => {
    let unauthorized = true;
    fetch(async url => {
      if (url === audioURL) return container();
      if (url.includes('/visitor_id?')) return Response.json({ responseContext: { visitorData: 'visitor' } });
      if (unauthorized) { unauthorized = false; return new Response('', { status: 401 }); }
      return Response.json({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [{ url: 'https://invalid.example/audio', mimeType: 'audio/mp4', bitrate: 128000 }] } });
    });
    expect((await plugin.stream({ id: 'aaaaaaaaaa1' })).type).toBe('m4a');
    expect(storage.get('cookie')).toBe('SAPISID=private');
    expect((await plugin.stream({ id: 'bbbbbbbbbb1' })).type).toBe('m4a');
    expect(processes.filter(process => process.command.includes('yt-dlp')).length).toBe(2);
  }, { cookie: 'SAPISID=private' });
});

// Explicitly unplayable items should retain the service reason without spawning an unnecessary extractor.
test('does not retry a service-declared unplayable item', async () => {
  await withPlugin(async ({ plugin, fetch, processes }) => {
    fetch(async url => Response.json(url.includes('/visitor_id?') ? { responseContext: { visitorData: 'visitor' } } : { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Removed item' } }));
    await expect(plugin.stream({ id: 'aaaaaaaaaa1' })).rejects.toMatchObject({ code: 'unavailable', message: 'Removed item' });
    expect(processes.length).toBe(0);
  });
});

// Requests using the old account while Google's dialog is open must not survive committing the new cookie.
test('invalidates account requests started during the sign-in dialog', async () => {
  await withPlugin(async ({ plugin, storage, fetch, finishSignIn }) => {
    let completeOld;
    fetch(async (url, options) => {
      if (options.headers.cookie === 'SAPISID=old') return new Promise(resolve => { completeOld = resolve; });
      return Response.json({ activeAccountHeaderRenderer: { accountName: { simpleText: 'New account' }, channelHandle: { simpleText: '@new' } } });
    });
    const signingIn = plugin.signIn();
    const old = plugin.account();
    finishSignIn('SAPISID=new');
    expect(await signingIn).toMatchObject({ id: '@new' });
    completeOld(new Response('', { status: 401 }));
    await expect(old).rejects.toMatchObject({ code: 'signIn' });
    expect(storage.get('cookie')).toBe('SAPISID=new');
  }, { cookie: 'SAPISID=old' });
});

// A 302 from a playable CDN must stay on the direct path, including subsequent cached plays.
test('plays and caches the verified redirect destination without spawning helpers', async () => {
  await withPlugin(async ({ plugin, fetch, processes, calls }) => {
    const finalURL = 'https://other.googlevideo.com/audio';
    fetch(async url => {
      if (url === audioURL) return new Response(null, { status: 302, headers: { location: finalURL } });
      if (url === finalURL) return container();
      if (url.includes('/visitor_id?')) return Response.json({ responseContext: { visitorData: 'visitor' } });
      return Response.json({ playabilityStatus: { status: 'OK' }, streamingData: {
        adaptiveFormats: [{ url: audioURL, mimeType: 'audio/mp4', bitrate: 128000 }],
      } });
    });
    expect((await plugin.stream({ id: 'aaaaaaaaaa1' })).url).toBe(finalURL);
    expect((await plugin.stream({ id: 'aaaaaaaaaa1' })).url).toBe(finalURL);
    expect(calls.filter(call => call.url === audioURL).length).toBe(1);
    expect(processes.length).toBe(0);
  }, { cookie: 'SAPISID=private' });
});
