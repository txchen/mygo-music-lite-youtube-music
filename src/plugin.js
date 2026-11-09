import { createClient } from './client.js';
import { createCatalog } from './catalog.js';
import { createExtractor } from './extractor.js';
import { failure } from './errors.js';
import { nodes, text, image } from './mapping.js';

const SIGN_IN_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const SIGN_IN_HANDOFF = 'https://www.youtube.com/signin?action_handle_signin=true&app=desktop&next=' + encodeURIComponent('https://music.youtube.com/');
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true&continue=' + encodeURIComponent(SIGN_IN_HANDOFF);

export function createPlugin(host, fetcher = fetch) {
  const stored = host.storage.get('session');
  const session = { cookie: typeof stored?.cookie === 'string' ? stored.cookie : '', account: stored?.account || null, generation: 0 };
  const client = createClient({ fetch: fetcher, session, language: () => host.language() });
  const catalog = createCatalog(client, session);
  const extract = createExtractor((command, args) => host.spawn(command, args), { fetch: fetcher });
  
  const search = params => catalog.search(params);
  const home = () => catalog.home();
  const browse = params => catalog.browse(params);
  const album = params => catalog.album(params);
  const artist = params => catalog.artist(params);
  const playlist = params => catalog.playlist(params);
  const playlists = () => catalog.playlists();
  const liked = params => catalog.liked(params);
  const isLiked = params => catalog.isLiked(params);
  const like = params => catalog.like(params);
  const stream = ({ id }) => extract(id);
  
  function readAccount(response) {
    const active = nodes(response, 'activeAccountHeaderRenderer')[0];
    if (!active || !text(active.accountName)) throw failure('signIn', 'YouTube Music did not confirm this account. Sign in again.');
    return { id: text(active.channelHandle) || text(active.email) || 'youtube-account', name: text(active.accountName), imageUrl: image(active.accountPhoto), page: 'library' };
  }
  async function signIn() {
    const generation = ++session.generation;
    catalog.clear();
    const result = await host.webSignIn({
      url: SIGN_IN_URL,
      cookiesOf: 'https://music.youtube.com',
      until: ['SAPISID', '__Secure-3PSID'],
      userAgent: SIGN_IN_USER_AGENT,
    });
    if (generation !== session.generation) throw failure('signIn', 'This sign-in was cancelled.');
    if (!result?.cookie || /[\r\n\0]/.test(result.cookie)) throw failure('signIn', 'YouTube Music did not return a valid sign-in.');
    const response = await client.request('account/account_menu', {}, { signed: true, cookie: result.cookie });
    if (generation !== session.generation) throw failure('signIn', 'This sign-in was cancelled.');
    const account = readAccount(response);
    session.generation++;
    catalog.clear();
    session.cookie = result.cookie;
    session.account = account;
    host.storage.set('session', { cookie: session.cookie, account });
    return account;
  }
  function signOut() {
    session.generation++;
    session.cookie = '';
    session.account = null;
    catalog.clear();
    host.storage.remove('session');
  }
  async function account() {
    if (!session.cookie) return null;
    const response = await client.request('account/account_menu', {}, { signed: true });
    session.account = readAccount(response);
    return session.account;
  }
  return { search, home, browse, album, artist, playlist, playlists, liked, isLiked, like, stream, signIn, signOut, account };
}
