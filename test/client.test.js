import { test, expect } from 'bun:test';
import { createClient, authHeaders } from '../src/client.js';
import { sha1 } from '../src/sha1.js';

const bootstrap = () => new Response('{"INNERTUBE_CLIENT_VERSION":"1.test","VISITOR_DATA":"visitor"}');

// YouTube's request digest uses UTF-8 input and the protocol's SHA-1 digest.
test('SHA1 matches standard vectors', () => {
  expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  expect(sha1('你好')).toBe('440ee0853ad1e99f962b63e459ef992d7c211722');
});

// Public requests never send the stored account cookie or authorization header.
test('sends credentials only on signed API requests', async () => {
  const calls = [];
  const session = { cookie: 'SAPISID=private', generation: 0 };
  const client = createClient({ session, fetch: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/') ? bootstrap() : Response.json({ ok: true });
  } });
  await client.request('search', { query: 'song' });
  await client.request('browse', { browseId: 'VLLM' }, { signed: true });
  expect(calls[0].options.headers.cookie).toBeUndefined();
  expect(calls[1].options.headers.cookie).toBeUndefined();
  expect(calls[2].options.headers.cookie).toBe('SAPISID=private');
  expect(calls[2].options.headers.authorization).toMatch(/^SAPISIDHASH \d+_[a-f0-9]{40}$/);
});

// Missing credentials and header injection fail before they can reach the service.
test('rejects missing or multiline sign-in cookies', async () => {
  expect(() => authHeaders('SAPISID=x\r\nBad: header')).toThrow();
  expect(() => authHeaders('SID=only')).toThrow();
  const client = createClient({ session: { cookie: '', generation: 0 }, fetch: () => { throw new Error('must not fetch'); } });
  await expect(client.request('browse', {}, { signed: true })).rejects.toMatchObject({ code: 'signIn' });
});

// A response from an account that signed out while it was loading cannot populate a cache.
test('rejects responses after account generation changes', async () => {
  const session = { cookie: '', generation: 0 };
  let resolve;
  let requested;
  const started = new Promise(r => { requested = r; });
  const client = createClient({ session, fetch: async url => {
    if (url.endsWith('/')) return bootstrap();
    requested();
    return new Promise(r => { resolve = r; });
  } });
  const result = client.request('search');
  await started;
  session.generation++;
  resolve(Response.json({ contents: {} }));
  await expect(result).rejects.toMatchObject({ code: 'unavailable' });
});

// Expired sessions produce the host's sign-in action and service errors retain no raw response.
test('maps expired auth and malformed service responses', async () => {
  for (const [response, code] of [[new Response('', { status: 403 }), 'signIn'], [new Response('not-json'), 'unavailable'], [Response.json({ responseContext: { mainAppWebResponseContext: { loggedOut: true } } }), 'signIn']]) {
    const client = createClient({ session: { cookie: 'SAPISID=x', generation: 0 }, fetch: async url => url.endsWith('/') ? bootstrap() : response });
    await expect(client.request('browse', {}, { signed: true })).rejects.toMatchObject({ code });
  }
});

// An exhausted operation budget prevents another network request.
test('enforces operation deadline before bootstrap', async () => {
  const client = createClient({ session: { cookie: '', generation: 0 }, fetch: () => { throw new Error('must not fetch'); } });
  await expect(client.request('search', {}, { deadline: 0 })).rejects.toMatchObject({ code: 'unavailable' });
});

// Signing out during bootstrap prevents a later request from sending captured account cookies.
test('does not send captured credentials after sign-out during bootstrap', async () => {
  const session = { cookie: 'SAPISID=old', generation: 0 };
  let resolve;
  let calls = 0;
  const client = createClient({ session, fetch: () => {
    calls++;
    return new Promise(r => { resolve = r; });
  } });
  const result = client.request('browse', {}, { signed: true });
  session.cookie = '';
  session.generation++;
  resolve(bootstrap());
  await expect(result).rejects.toMatchObject({ code: 'unavailable' });
  expect(calls).toBe(1);
});
