import { failure, isFailure } from './errors.js';
import { sha1 } from './sha1.js';
export const ORIGIN = 'https://music.youtube.com';
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
export function cookieValue(cookie, name) {
  return cookie.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';
}
export function authHeaders(cookie, now = Date.now()) {
  if (/[\r\n\0]/.test(cookie)) throw failure('signIn', 'The saved sign-in is invalid. Sign in again.');
  const sapisid = cookieValue(cookie, 'SAPISID') || cookieValue(cookie, '__Secure-3PAPISID');
  if (!sapisid) throw failure('signIn', 'Sign in to YouTube Music first.');
  const timestamp = Math.floor(now / 1000);
  return { cookie, authorization: `SAPISIDHASH ${timestamp}_${sha1(`${timestamp} ${sapisid} ${ORIGIN}`)}`, 'x-goog-authuser': '0', 'x-origin': ORIGIN };
}
export function createClient({ fetch: fetcher = fetch, session, language = () => 'en' }) {
  let config;
  let bootstrapPromise;
  async function read(url, options, deadline) {
    const controller = new AbortController();
    const remaining = Math.min(10000, deadline - Date.now());
    if (remaining <= 0) throw failure('unavailable', 'YouTube Music took too long to answer. Try again.');
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetcher(url, { ...options, signal: controller.signal });
      if (response.status === 401 || response.status === 403) throw failure(options.signed ? 'signIn' : 'unavailable', options.signed ? 'Your YouTube Music sign-in expired. Sign in again.' : 'YouTube Music refused this request. Try again later.');
      if (!response.ok) throw failure('unavailable', `YouTube Music returned HTTP ${response.status}. Try again later.`);
      const body = await response.text();
      if (body.length > 12 * 1024 * 1024) throw failure('unavailable', 'YouTube Music returned an oversized response.');
      return body;
    } catch (error) {
      if (isFailure(error)) throw error;
      throw failure('unavailable', controller.signal.aborted ? 'YouTube Music took too long to answer. Try again.' : 'Could not reach YouTube Music. Check your connection.');
    } finally { clearTimeout(timer); }
  }
  async function bootstrap(deadline) {
    if (config) return config;
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const html = await read(ORIGIN + '/', { headers: { 'user-agent': USER_AGENT } }, deadline);
        const version = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
        const visitor = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] || '';
        if (!version) throw failure('unavailable', 'YouTube Music could not initialize. Its website may have changed.');
        config = { version, visitor };
        return config;
      })().finally(() => { bootstrapPromise = null; });
    }
    return bootstrapPromise;
  }
  async function request(endpoint, body = {}, { signed = false, cookie, deadline = Date.now() + 24000 } = {}) {
    const generation = session.generation;
    const credentials = cookie === undefined ? session.cookie : cookie;
    if (signed && !credentials) throw failure('signIn', 'Sign in to YouTube Music first.');
    const initial = await bootstrap(deadline);
    if (generation !== session.generation) throw failure('unavailable', 'Your account changed. Open this page again.');
    const headers = { 'content-type': 'application/json', 'user-agent': USER_AGENT, origin: ORIGIN, 'x-youtube-client-name': '67', 'x-youtube-client-version': initial.version };
    if (initial.visitor) headers['x-goog-visitor-id'] = initial.visitor;
    if (signed) Object.assign(headers, authHeaders(credentials));
    const context = { client: { clientName: 'WEB_REMIX', clientVersion: initial.version, hl: language() === 'zh-CN' ? 'zh-CN' : 'en', gl: 'US', visitorData: initial.visitor }, user: { lockedSafetyMode: false } };
    const raw = await read(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, { method: 'POST', headers, body: JSON.stringify({ ...body, context }), signed }, deadline);
    if (generation !== session.generation) throw failure('unavailable', 'Your account changed. Open this page again.');
    let data;
    try { data = JSON.parse(raw); } catch { throw failure('unavailable', 'YouTube Music returned an unreadable response.'); }
    if (data.error) throw failure(data.error.code === 401 || data.error.code === 403 ? 'signIn' : 'unavailable', 'YouTube Music could not complete this request.');
    if (signed && data.responseContext?.mainAppWebResponseContext?.loggedOut === true) throw failure('signIn', 'Your YouTube Music sign-in expired. Sign in again.');
    return data;
  }
  return { request };
}
