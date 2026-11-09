import { test, expect } from 'bun:test';
import { shelf } from './helpers.js';
import { createPlugin } from '../src/plugin.js';
async function withPlugin(run) {
  const storage = new Map([['session', { cookie: 'SAPISID=old', account: { id: 'old', name: 'Old account' } }]]);
  let finishSignIn;
  const seen = [];
  const host = {
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    language: () => 'en',
    webSignIn: () => new Promise(resolve => { finishSignIn = resolve; }),
  };
  const fetcher = async (url, options) => {
    if (url.endsWith('/')) return new Response('{"INNERTUBE_CLIENT_VERSION":"1.test"}');
    const cookie = options.headers.cookie;
    seen.push({ url, cookie });
    if (url.includes('account/account_menu')) return Response.json({ activeAccountHeaderRenderer: { accountName: { simpleText: 'New account' }, channelHandle: { simpleText: '@new' } } });
    return Response.json(shelf([cookie === 'SAPISID=old' ? 'aaaaaaaaaa1' : 'bbbbbbbbbb1']));
  };
  const plugin = createPlugin(host, fetcher);
  await run({ plugin, storage, seen, finish: cookie => finishSignIn({ cookie }) });
}

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
