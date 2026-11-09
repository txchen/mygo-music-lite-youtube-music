import { test, expect } from 'bun:test';
import { shelf } from './helpers.js';
import { createPlugin } from '../src/plugin.js';
async function withPlugin(run) {
  const storage = new Map([['session', { cookie: 'SAPISID=old', account: { id: 'old', name: 'Old account' } }]]);
  let finishSignIn;
  const seen = [];
  const signIns = [];
  const host = {
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    language: () => 'en',
    webSignIn: options => {
      signIns.push(options);
      return new Promise(resolve => { finishSignIn = resolve; });
    },
  };
  const fetcher = async (url, options) => {
    if (url.endsWith('/')) return new Response('{"INNERTUBE_CLIENT_VERSION":"1.test"}');
    const cookie = options.headers.cookie;
    seen.push({ url, cookie, userAgent: options.headers['user-agent'] });
    if (url.includes('account/account_menu')) return Response.json({ activeAccountHeaderRenderer: { accountName: { simpleText: 'New account' }, channelHandle: { simpleText: '@new' } } });
    return Response.json(shelf([cookie === 'SAPISID=old' ? 'aaaaaaaaaa1' : 'bbbbbbbbbb1']));
  };
  const plugin = createPlugin(host, fetcher);
  await run({ plugin, storage, seen, signIns, finish: cookie => finishSignIn({ cookie }) });
}

// The failing login used a Chrome identity and skipped the original plugin's YouTube handoff.
test('sign-in uses a WebKit browser identity and waits for the YouTube session handoff', async () => {
  await withPlugin(async ({ plugin, signIns, seen, finish }) => {
    const signingIn = plugin.signIn();
    const options = signIns[0];
    expect(options.userAgent).toContain('AppleWebKit/605.1.15');
    expect(options.userAgent).toMatch(/Version\/[\d.]+ Safari\/605\.1\.15/);
    expect(options.userAgent).not.toContain('Chrome/');
    expect(options.cookiesOf).toBe('https://music.youtube.com');
    expect(new Set(options.until)).toEqual(new Set(['SAPISID', '__Secure-3PSID']));

    const login = new URL(options.url);
    expect(login.origin + login.pathname).toBe('https://accounts.google.com/ServiceLogin');
    expect(Object.fromEntries(login.searchParams)).toMatchObject({ ltmpl: 'music', service: 'youtube', uilel: '3', passive: 'true' });
    const handoff = new URL(login.searchParams.get('continue'));
    expect(handoff.origin + handoff.pathname).toBe('https://www.youtube.com/signin');
    expect(Object.fromEntries(handoff.searchParams)).toEqual({ action_handle_signin: 'true', app: 'desktop', next: 'https://music.youtube.com/' });
    expect(seen).toEqual([]);

    finish('SAPISID=new; __Secure-3PSID=session');
    expect(await signingIn).toMatchObject({ id: '@new' });
    expect(seen[0].userAgent).toContain('Chrome/');
  });
});

// Searches made with the previous account while the sign-in window is open cannot survive account commit.
test('successful sign-in clears data loaded during the sign-in dialog', async () => {
  await withPlugin(async ({ plugin, seen, finish, storage }) => {
    const signingIn = plugin.signIn();
    const old = await plugin.search({ query: 'song', kind: 'tracks', offset: 0 });
    expect(old.tracks[0].id).toBe('aaaaaaaaaa1');
    finish('SAPISID=new');
    expect(await signingIn).toMatchObject({ id: '@new', name: 'New account' });
    await plugin.search({ query: 'song', kind: 'tracks', offset: 1 });
    const searches = seen.filter(call => call.url.includes('/search'));
    expect(searches.map(call => call.cookie)).toEqual(['SAPISID=old', 'SAPISID=new']);
    expect(storage.get('session').cookie).toBe('SAPISID=new');
  });
});

// Signing out while the browser dialog is open cancels its eventual result and clears persistent credentials.
test('sign-out prevents a delayed browser result from restoring an account', async () => {
  await withPlugin(async ({ plugin, storage, finish, seen }) => {
    const signingIn = plugin.signIn();
    plugin.signOut();
    finish('SAPISID=new');
    await expect(signingIn).rejects.toMatchObject({ code: 'signIn' });
    expect(await plugin.account()).toBe(null);
    expect(storage.has('session')).toBe(false);
    expect(seen.length).toBe(0);
  });
});
