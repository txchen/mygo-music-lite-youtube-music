// src/errors.js
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function isFailure(error) {
  return ["signIn", "setup", "unavailable", "unsupported"].includes(error?.code);
}
function requireVideoID(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw failure("unavailable", "This item has no playable YouTube video ID.");
  }
  return id;
}

// src/extractor.js
var PROGRAMS = ["yt-dlp", "/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"];
var RUNTIMES = ["deno", "/opt/homebrew/bin/deno", "/usr/local/bin/deno"];
var FORMAT = "bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/bestaudio[protocol=http]";
function streamFromInfo(info) {
  const format = info.requested_downloads?.[0] || info;
  let url;
  try {
    url = new URL(format.url);
  } catch {
    throw failure("unavailable", "YouTube did not provide a direct audio file.");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.endsWith(".googlevideo.com") || url.username || url.password || !["http", "https"].includes(format.protocol) || /\.(m3u8|mpd)(?:$|[?])/i.test(url.pathname) || !["m4a", "webm"].includes(format.ext) || !format.acodec || format.acodec === "none" || format.vcodec && format.vcodec !== "none") {
    throw failure("unavailable", "This item has no direct M4A or WebM audio file supported by MyGo Music Lite.");
  }
  const headers = {};
  for (const [name, value] of Object.entries(format.http_headers || info.http_headers || {})) {
    if (["user-agent", "referer", "origin", "accept", "accept-language"].includes(name.toLowerCase()) && typeof value === "string" && !/[\r\n\0]/.test(value))
      headers[name] = value;
  }
  return { url: url.href, type: format.ext, headers, ...Number.isFinite(format.filesize) && format.filesize > 0 ? { size: format.filesize } : {} };
}
async function run(process, deadline, limit) {
  let timer;
  let finished = false;
  let collected;
  try {
    process.closeStdin();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          process.kill();
        } catch {}
        reject(failure("unavailable", "YouTube audio extraction timed out. Try again."));
      }, Math.max(1, deadline - Date.now()));
    });
    collected = (async () => {
      let output = "";
      let lines = 0;
      for (;; ) {
        const line = await process.readLine();
        if (line === null)
          break;
        output += line;
        if (++lines > 16 || output.length > limit)
          throw failure("unavailable", "The audio helper returned too much output. Update yt-dlp and try again.");
      }
      const code = await process.wait();
      finished = true;
      return { output, code };
    })();
    return await Promise.race([collected, timeout]);
  } finally {
    clearTimeout(timer);
    if (!finished) {
      try {
        process.kill();
      } catch {}
      if (collected)
        await collected.catch(() => {});
      if (!finished) {
        try {
          while (await process.readLine() !== null) {}
        } catch {}
        try {
          await process.wait();
        } catch {}
      }
    }
  }
}
async function probe(stream, fetcher, signal) {
  let url = new URL(stream.url);
  const visited = new Set;
  for (let hop = 0;hop <= 5; hop++) {
    if (visited.has(url.href))
      throw failure("unavailable", "The audio server returned a redirect loop.");
    visited.add(url.href);
    const response = await fetcher(url.href, { headers: { ...stream.headers, Range: "bytes=0-511" }, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, url: url.href };
    const location = response.headers.get("location");
    try {
      await response.body?.cancel();
    } catch {}
    if (!location || hop === 5)
      throw failure("unavailable", "The audio server returned an invalid redirect.");
    let next;
    try {
      next = new URL(location, url);
    } catch {
      throw failure("unavailable", "The audio server returned an invalid redirect.");
    }
    if (next.protocol !== "https:" || !next.hostname.endsWith(".googlevideo.com") || next.username || next.password || next.port || next.hash || /\.(m3u8|mpd)(?:$|[?])/i.test(next.pathname)) {
      throw failure("unavailable", "The audio server redirected outside the supported audio CDN.");
    }
    url = next;
  }
}
async function ready(stream, fetcher, deadline, retryDelays) {
  let attempt = 0;
  while (Date.now() < deadline) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), Math.min(3000, deadline - Date.now()));
    let response;
    let retry = false;
    try {
      const checked = await probe(stream, fetcher, controller.signal);
      response = checked.response;
      if (response.status === 206) {
        const reader = response.body?.getReader();
        if (!reader)
          throw failure("unavailable", "The audio server returned an unreadable response.");
        let bytes = new Uint8Array;
        try {
          while (bytes.length < 8) {
            const part = await reader.read();
            if (part.done)
              break;
            if (part.value.length + bytes.length > 4096)
              throw failure("unavailable", "The audio server ignored a small range request.");
            const joined = new Uint8Array(bytes.length + part.value.length);
            joined.set(bytes);
            joined.set(part.value, bytes.length);
            bytes = joined;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const m4a = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
        const webm = bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163;
        if (stream.type === "m4a" ? m4a : webm)
          return { ...stream, url: checked.url };
        throw failure("unavailable", "The audio server returned an unexpected audio container.");
      }
      retry = [403, 502, 503, 504].includes(response.status);
      if (!retry)
        throw failure("unavailable", `The audio server returned HTTP ${response.status}. Try another public item.`);
    } catch (error) {
      if (isFailure(error))
        throw error;
      retry = true;
    } finally {
      clearTimeout(timer);
      controller.abort();
      try {
        await response?.body?.cancel();
      } catch {}
    }
    if (!retry)
      break;
    if (!retryDelays.length)
      break;
    const delay = retryDelays[Math.min(attempt++, retryDelays.length - 1)];
    const remaining = deadline - Date.now();
    if (remaining <= delay)
      break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw failure("unavailable", "YouTube's audio server is not ready or refused this public item. Try again or choose another song.");
}
function permissionError(error) {
  return /allow|permission/i.test(String(error));
}
function createExtractor(spawn, { timeout = 25000, fetch: fetcher = fetch, retryDelays = [1000, 2000, 4000] } = {}) {
  let runtime;
  return async function extract(id, options = {}) {
    requireVideoID(id);
    const deadline = Math.min(Date.now() + timeout, options.deadline ?? Infinity);
    if (Date.now() >= deadline)
      throw failure("unavailable", "YouTube audio extraction timed out. Try again.");
    if (!runtime) {
      for (const command of RUNTIMES) {
        let child2;
        try {
          child2 = spawn(command, ["--version"]);
        } catch (error) {
          if (permissionError(error))
            throw failure("setup", "Allow this plugin to run programs in Settings > Plugins, then try again.");
          continue;
        }
        const result = await run(child2, deadline, 4096);
        if (result.code === 0 && /^deno\s/im.test(result.output)) {
          runtime = command;
          break;
        }
      }
      if (!runtime)
        throw failure("setup", "Install Deno, then reopen MyGo Music Lite. See the plugin README.");
    }
    let child;
    for (const command of PROGRAMS) {
      try {
        child = spawn(command, ["--ignore-config", "--config-locations", "-", "--js-runtimes", `deno:${runtime}`, "--no-playlist", "--no-warnings", "--quiet", "--skip-download", "--dump-single-json", "--socket-timeout", "8", "--retries", "0", "--extractor-retries", "0", "--format", FORMAT, "--", `https://www.youtube.com/watch?v=${id}`]);
        break;
      } catch (error) {
        if (permissionError(error))
          throw failure("setup", "Allow this plugin to run programs in Settings > Plugins, then try again.");
      }
    }
    if (!child)
      throw failure("setup", "Install yt-dlp, then reopen MyGo Music Lite. See the plugin README.");
    const { output, code } = await run(child, deadline, 2 * 1024 * 1024);
    if (code !== 0)
      throw failure("unavailable", "YouTube could not provide public audio for this item. It may require an account, be restricted, or need a newer yt-dlp.");
    let info;
    try {
      info = JSON.parse(output);
    } catch {
      throw failure("unavailable", "yt-dlp returned an unreadable audio response. Update yt-dlp.");
    }
    return ready(streamFromInfo(info), fetcher, deadline, retryDelays);
  };
}

// src/index.js
var site = "https://music.youtube.com";
var webUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var t = host.t;
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
var previousSession = host.storage.get("session");
if (!host.storage.get("cookie") && typeof previousSession?.cookie === "string") {
  host.storage.set("cookie", previousSession.cookie);
  host.storage.remove("session");
}
var cookie = () => host.storage.get("cookie") || "";
var sessionGeneration = 0;
function cookieValue(name) {
  for (const part of cookie().split(";")) {
    const at = part.indexOf("=");
    if (part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim();
  }
  return "";
}
function needAccount() {
  if (!cookie())
    throw fail("signIn");
}
function sha1(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const bits = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56)
    bytes.push(0);
  for (let i = 7;i >= 0; i--)
    bytes.push(i >= 4 ? 0 : bits >>> i * 8 & 255);
  const rotl = (x, n) => x << n | x >>> 32 - n;
  const h = [1732584193, 4023233417, 2562383102, 271733878, 3285377520];
  for (let at = 0;at < bytes.length; at += 64) {
    const w = [];
    for (let i = 0;i < 16; i++) {
      w[i] = bytes[at + i * 4] << 24 | bytes[at + i * 4 + 1] << 16 | bytes[at + i * 4 + 2] << 8 | bytes[at + i * 4 + 3];
    }
    for (let i = 16;i < 80; i++)
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0;i < 80; i++) {
      const [f, k] = i < 20 ? [b & c | ~b & d, 1518500249] : i < 40 ? [b ^ c ^ d, 1859775393] : i < 60 ? [b & c | b & d | c & d, 2400959708] : [b ^ c ^ d, 3395469782];
      const t2 = rotl(a, 5) + f + e + k + w[i] | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t2];
    }
    [a, b, c, d, e].forEach((v, i) => h[i] = h[i] + v | 0);
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}
function authHeaders(origin = site) {
  const sapisid = cookieValue("__Secure-3PAPISID") || cookieValue("SAPISID");
  if (!sapisid)
    return {};
  const now = Math.floor(Date.now() / 1000);
  return {
    cookie: cookie(),
    authorization: `SAPISIDHASH ${now}_${sha1(`${now} ${sapisid} ${origin}`)}`,
    "x-goog-authuser": "0"
  };
}
function clientVersion() {
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `1.${d}.01.00`;
}
var remix = {
  get client() {
    return { clientName: "WEB_REMIX", clientVersion: clientVersion(), hl: host.language() === "zh-CN" ? "zh-CN" : "en" };
  }
};
var android = {
  client: { clientName: "ANDROID_MUSIC", clientVersion: "7.21.50", androidSdkVersion: 34 },
  headers: { "user-agent": "com.google.android.apps.youtube.music/7.21.50 (Linux; U; Android 14) gzip" }
};
var visionUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
var visionOS = (visitor) => ({
  client: {
    clientName: "VISIONOS",
    clientVersion: "1.02",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    userAgent: visionUA,
    osName: "visionOS",
    osVersion: "26.5.23O471",
    visitorData: visitor
  },
  headers: {
    "user-agent": visionUA,
    "x-goog-visitor-id": visitor,
    "x-youtube-client-name": "101",
    "x-youtube-client-version": "1.02"
  },
  anonymous: true
});
async function call(endpoint, body, as = remix, signal) {
  const generation = sessionGeneration;
  const res = await fetch(`${site}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "user-agent": webUA,
      origin: site,
      "x-origin": site,
      ...as.anonymous ? {} : authHeaders(),
      ...as.headers
    },
    body: JSON.stringify({ context: { client: as.client }, ...body })
  });
  if (!as.anonymous && generation !== sessionGeneration)
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  if (res.status === 401) {
    if (as.anonymous)
      throw new Error(`${endpoint}: ${res.status}`);
    endSession();
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  }
  if (!res.ok)
    throw new Error(`${endpoint}: ${res.status}`);
  const answer = await res.json();
  if (!as.anonymous && generation !== sessionGeneration)
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  return answer;
}
var browseId = (id) => call("browse", { browseId: id });
function findAll(node, name, out = []) {
  if (Array.isArray(node)) {
    for (const item of node)
      findAll(item, name, out);
  } else if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === name)
        out.push(node[key]);
      else
        findAll(node[key], name, out);
    }
  }
  return out;
}
var findOne = (node, name) => findAll(node, name)[0];
var textOf = (t2) => t2 ? t2.simpleText || (t2.runs || []).map((r) => r.text).join("") : "";
function imageOf(node) {
  const list = node && findOne(node, "thumbnails");
  const url = list && list.length ? list[list.length - 1].url : "";
  if (!url)
    return;
  return url.replace(/=w\d+-h\d+[^/]*$/, "=w544-h544-l90-rj");
}
function msOf(text) {
  if (!text || !/^\d+(:\d+)+$/.test(text))
    return 0;
  return text.split(":").reduce((sum, n) => sum * 60 + Number(n), 0) * 1000;
}
var pageTypeOf = (nav) => nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || "";
var plainPlaylistId = (id) => (id || "").replace(/^VL/, "");
function creditsOf(runs) {
  const out = { artists: [], album: null, duration: 0, names: [] };
  for (const run2 of runs || []) {
    const text = run2.text;
    if (!text || /^\s*[•·,&]\s*$/.test(text))
      continue;
    const nav = run2.navigationEndpoint;
    const type = pageTypeOf(nav);
    if (type === "MUSIC_PAGE_TYPE_ARTIST" || type === "MUSIC_PAGE_TYPE_USER_CHANNEL") {
      out.artists.push({ id: nav.browseEndpoint.browseId, name: text });
    } else if (type === "MUSIC_PAGE_TYPE_ALBUM" || type === "MUSIC_PAGE_TYPE_AUDIOBOOK") {
      out.album = { id: nav.browseEndpoint.browseId, name: text };
    } else if (msOf(text)) {
      out.duration = msOf(text);
    } else {
      out.names.push(text);
    }
  }
  return out;
}
function trackFrom(id, name, credits, image, unavailable) {
  const artists = credits.artists.length ? credits.artists : credits.names.slice(0, 1).map((n) => ({ id: "", name: n }));
  return {
    id,
    name,
    artists,
    album: credits.album ? { ...credits.album, imageUrl: image } : { id: "", name: "", imageUrl: image },
    duration: credits.duration,
    url: `${site}/watch?v=${id}`,
    unavailable: unavailable || undefined
  };
}
function rowOf(r) {
  const columns = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text);
  const name = textOf(columns[0]);
  const nav = columns[0]?.runs?.[0]?.navigationEndpoint;
  const videoId = r.playlistItemData?.videoId || nav?.watchEndpoint?.videoId;
  const runs = columns.slice(1).flatMap((c) => [...c?.runs || [], { text: "•" }]);
  const fixed = (r.fixedColumns || []).map((c) => textOf(c.musicResponsiveListItemFixedColumnRenderer?.text));
  const credits = creditsOf(runs);
  credits.duration = credits.duration || msOf(fixed[0]);
  const image = imageOf(r.thumbnail);
  if (videoId) {
    const grey = r.musicItemRendererDisplayPolicy === "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT";
    return { kind: "track", value: trackFrom(videoId, name, credits, image, grey) };
  }
  const target = r.navigationEndpoint;
  return collectionOf(target, name, runs, image);
}
function cardOf(r) {
  const name = textOf(r.title);
  const runs = r.subtitle?.runs || [];
  const image = imageOf(r.thumbnailRenderer);
  const nav = r.navigationEndpoint;
  if (nav?.watchEndpoint?.videoId) {
    const credits = creditsOf(runs);
    credits.names = credits.names.slice(1);
    return { kind: "track", value: trackFrom(nav.watchEndpoint.videoId, name, credits, image) };
  }
  return collectionOf(nav, name, runs, image);
}
function collectionOf(nav, name, runs, image) {
  const id = nav?.browseEndpoint?.browseId;
  if (!id)
    return null;
  const credits = creditsOf(runs);
  switch (pageTypeOf(nav)) {
    case "MUSIC_PAGE_TYPE_ARTIST":
    case "MUSIC_PAGE_TYPE_USER_CHANNEL":
      return { kind: "artist", value: { id, name, imageUrl: image } };
    case "MUSIC_PAGE_TYPE_ALBUM":
    case "MUSIC_PAGE_TYPE_AUDIOBOOK":
      return { kind: "album", value: { id, name, imageUrl: image, artists: credits.artists, released: credits.names.find((n) => /^\d{4}$/.test(n)) } };
    case "MUSIC_PAGE_TYPE_PLAYLIST":
      return { kind: "playlist", value: { id: plainPlaylistId(id), name, imageUrl: image, owner: credits.artists[0]?.name || credits.names[1] || "" } };
  }
  return null;
}
function itemsOf(list) {
  const out = [];
  for (const item of list || []) {
    const row = item.musicResponsiveListItemRenderer;
    const card = item.musicTwoRowItemRenderer;
    const got = row ? rowOf(row) : card ? cardOf(card) : null;
    if (got)
      out.push(got);
  }
  return out;
}
var ofKind = (items, kind) => items.filter((i) => i.kind === kind).map((i) => i.value);
async function withDurations(tracks) {
  const missing = tracks.filter((t2) => !t2.duration).map((t2) => t2.id);
  if (!missing.length)
    return tracks;
  const known = {};
  try {
    const r = await call("music/get_queue", { videoIds: [...new Set(missing)].slice(0, 100) });
    for (const v of findAll(r, "playlistPanelVideoRenderer"))
      known[v.videoId] = msOf(textOf(v.lengthText));
  } catch (e) {
    console.warn(`get_queue: ${e.message}`);
  }
  for (const t2 of tracks)
    t2.duration = t2.duration || known[t2.id] || 0;
  return tracks;
}
function shelfTitle(shelf) {
  return textOf(shelf.title) || textOf(findOne(shelf.header, "title"));
}
async function sectionsOf(answer) {
  const sections = [];
  for (const list of findAll(answer, "sectionListRenderer").concat(findAll(answer, "sectionListContinuation"))) {
    for (const entry of list.contents || []) {
      const shelf = entry.musicCarouselShelfRenderer || entry.musicShelfRenderer || entry.musicPlaylistShelfRenderer || entry.gridRenderer;
      if (!shelf)
        continue;
      const items = itemsOf(shelf.contents || shelf.items);
      if (!items.length)
        continue;
      sections.push({
        title: shelfTitle(shelf),
        tracks: await withDurations(ofKind(items, "track")),
        albums: ofKind(items, "album"),
        artists: ofKind(items, "artist"),
        playlists: ofKind(items, "playlist")
      });
    }
  }
  return sections;
}
function nextToken(node) {
  if (!node)
    return "";
  const old = findOne(node, "nextContinuationData");
  if (old?.continuation)
    return old.continuation;
  return findOne(node, "continuationCommand")?.token || "";
}
var tokens = new Map;
function pageToken(key, offset) {
  return offset > 0 ? tokens.get(`${key}\x00${offset}`) : null;
}
function keepToken(key, offset, token) {
  if (token)
    tokens.set(`${key}\x00${offset}`, token);
  return Boolean(token);
}
function rowsOf(answer) {
  const further = findOne(answer, "onResponseReceivedActions") || findOne(answer, "musicShelfContinuation") || findOne(answer, "musicPlaylistShelfContinuation");
  if (further) {
    const list = findAll(further, "continuationItems")[0] || further.contents || [];
    return { items: itemsOf(list), token: nextToken(further) };
  }
  const shelf = findOne(answer, "musicPlaylistShelfRenderer") || findOne(answer, "musicShelfRenderer");
  return { items: itemsOf(shelf?.contents), token: nextToken(shelf) };
}
async function account() {
  if (!cookie())
    return null;
  const r = await call("account/account_menu", {});
  const header = findOne(r, "activeAccountHeaderRenderer");
  if (!header)
    return null;
  const name = textOf(header.accountName);
  return { id: textOf(header.channelHandle) || name, name, imageUrl: imageOf(header.accountPhoto) };
}
var signInPage = "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true" + "&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F";
var browserUA = host.platform === "darwin" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
async function signIn() {
  let generation = ++sessionGeneration;
  const { cookie: session } = await host.webSignIn({
    url: signInPage,
    cookiesOf: site,
    until: ["SAPISID", "__Secure-3PSID"],
    userAgent: browserUA
  });
  if (generation !== sessionGeneration)
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  generation = ++sessionGeneration;
  host.storage.set("cookie", session);
  host.storage.remove("session");
  tokens.clear();
  likedSet = null;
  const me = await account();
  if (generation !== sessionGeneration)
    throw fail("signIn", t("Your YouTube Music session has ended: sign in again"));
  if (!me) {
    endSession();
    throw new Error(t("YouTube Music didn't take that sign-in: try again"));
  }
  return me;
}
function signOut() {
  endSession();
}
function endSession() {
  sessionGeneration++;
  host.storage.remove("cookie");
  host.storage.remove("session");
  tokens.clear();
  likedSet = null;
}
async function home() {
  const answer = await browseId("FEmusic_home");
  const sections = await sectionsOf(answer);
  let token = nextToken(findOne(answer, "sectionListRenderer"));
  for (let i = 0;token && i < 2; i++) {
    const more = await call("browse", { continuation: token });
    sections.push(...await sectionsOf(more));
    token = nextToken(findOne(more, "sectionListContinuation"));
  }
  return { title: t("Home"), sections };
}
async function browse({ page }) {
  const ids = { charts: ["FEmusic_charts", "Charts"], new: ["FEmusic_new_releases", "New Releases"] };
  const known = ids[page];
  if (known)
    return { title: t(known[1]), sections: await sectionsOf(await browseId(known[0])) };
  throw fail("unavailable", t("no such page"));
}
var filters = {
  tracks: "EgWKAQIIAWoMEA4QChADEAQQCRAF",
  albums: "EgWKAQIYAWoMEA4QChADEAQQCRAF",
  artists: "EgWKAQIgAWoMEA4QChADEAQQCRAF",
  playlists: "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D"
};
async function search({ query, kind, offset }) {
  const filter = filters[kind];
  if (!filter)
    return { [kind]: [], more: false };
  const key = `search\x00${kind}\x00${query}`;
  const token = pageToken(key, offset);
  if (offset > 0 && !token)
    return { [kind]: [], more: false };
  const answer = await call("search", token ? { continuation: token } : { query, params: decodeURIComponent(filter) });
  const { items, token: next } = rowsOf(answer);
  const single = { tracks: "track", albums: "album", artists: "artist", playlists: "playlist" }[kind];
  const found = ofKind(items, single);
  if (kind === "tracks")
    await withDurations(found);
  return { [kind]: found, more: keepToken(key, offset + found.length, next) };
}
async function suggest({ query }) {
  const r = await call("music/get_search_suggestions", { input: query });
  return findAll(r, "searchSuggestionRenderer").map((s) => textOf(s.suggestion)).filter(Boolean);
}
function headerOf(answer) {
  return findOne(answer, "musicResponsiveHeaderRenderer") || findOne(answer, "musicDetailHeaderRenderer") || {};
}
async function albumPage({ id }) {
  const answer = await browseId(id);
  const header = headerOf(answer);
  const credits = creditsOf([...header.straplineTextOne?.runs || [], ...header.subtitle?.runs || []]);
  const album = {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    artists: credits.artists,
    released: textOf(header.subtitle).match(/\b\d{4}\b/)?.[0]
  };
  const shelf = findOne(answer, "musicShelfRenderer");
  const tracks = ofKind(itemsOf(shelf?.contents), "track").map((t2) => ({
    ...t2,
    artists: t2.artists.length ? t2.artists : album.artists,
    album: { id, name: album.name, imageUrl: album.imageUrl }
  }));
  return { album, tracks: await withDurations(tracks) };
}
async function artistPage({ id }) {
  const answer = await browseId(id);
  const header = findOne(answer, "musicImmersiveHeaderRenderer") || findOne(answer, "musicVisualHeaderRenderer") || {};
  const sections = await sectionsOf(answer);
  return {
    artist: { id, name: textOf(header.title), imageUrl: imageOf(header.thumbnail || header.foregroundThumbnail) },
    tracks: sections.flatMap((s) => s.tracks).slice(0, 20),
    albums: sections.flatMap((s) => s.albums)
  };
}
var pagesAtMost = 30;
async function tracksOfAll(answer) {
  const out = [];
  let { items, token } = rowsOf(answer);
  out.push(...ofKind(items, "track"));
  for (let i = 0;token && i < pagesAtMost; i++) {
    ({ items, token } = rowsOf(await call("browse", { continuation: token })));
    out.push(...ofKind(items, "track"));
  }
  return out;
}
async function playlistPage({ id }) {
  const answer = await browseId(`VL${id}`);
  const header = headerOf(answer);
  const tracks = await withDurations(await tracksOfAll(answer));
  return {
    id,
    name: textOf(header.title),
    imageUrl: imageOf(header.thumbnail),
    description: textOf(findOne(header.description, "description") || header.description),
    owner: textOf(header.straplineTextOne),
    trackCount: tracks.length,
    tracks
  };
}
async function playlists() {
  if (!cookie())
    return [];
  const items = (await sectionsOf(await browseId("FEmusic_liked_playlists"))).flatMap((s) => s.playlists);
  return items.filter((p) => p.id !== "LM" && p.id !== "SE").map((p) => ({ ...p, saved: true }));
}
async function liked({ offset }) {
  needAccount();
  const token = pageToken("liked", offset);
  if (offset > 0 && !token)
    return { tracks: [], more: false };
  const answer = token ? await call("browse", { continuation: token }) : await browseId("VLLM");
  const { items, token: next } = rowsOf(answer);
  const tracks = await withDurations(ofKind(items, "track"));
  return { tracks, more: keepToken("liked", offset + tracks.length, next) };
}
var likedSet = null;
var likedAt = 0;
var likedFor = 5 * 60 * 1000;
async function likedIds() {
  if (likedSet && Date.now() - likedAt < likedFor)
    return likedSet;
  const set = new Set;
  let { items, token } = rowsOf(await browseId("VLLM"));
  for (let i = 0;; i++) {
    for (const t2 of ofKind(items, "track"))
      set.add(t2.id);
    if (!token || i >= 5)
      break;
    ({ items, token } = rowsOf(await call("browse", { continuation: token })));
  }
  likedSet = set;
  likedAt = Date.now();
  return set;
}
async function isLiked({ ids }) {
  const set = cookie() ? await likedIds() : new Set;
  return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
}
async function like({ id, on }) {
  needAccount();
  await call(on ? "like/like" : "like/removelike", { target: { videoId: id } });
  if (likedSet) {
    if (on)
      likedSet.add(id);
    else
      likedSet.delete(id);
  }
}
async function recent() {
  if (!cookie())
    return [];
  const sections = await sectionsOf(await browseId("FEmusic_history"));
  return sections.flatMap((s) => s.tracks).slice(0, 50);
}
var radio = { id: "radio", name: "Radio", description: "Songs like the one you played last." };
function stations() {
  return [radio];
}
async function played({ id }) {
  host.storage.set("lastPlayed", id);
  if (!cookie())
    return;
  try {
    await report(id);
  } catch (e) {
    console.warn(`reporting ${id} as played: ${e.message}`);
  }
}
async function report(id) {
  const r = await call("player", { videoId: id, playbackContext: { contentPlaybackContext: {} } });
  const base = r.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
  if (!base)
    throw new Error(t("YouTube gave no address to report it to"));
  const url = new URL(base);
  if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(url.hostname)) {
    throw new Error(`not sending your session to ${url.hostname}`);
  }
  url.searchParams.set("ver", "2");
  url.searchParams.set("c", "WEB_REMIX");
  url.searchParams.set("cpn", playbackNonce());
  const res = await fetch(url.href, {
    headers: { "user-agent": webUA, referer: `${site}/`, ...authHeaders(url.origin) }
  });
  if (!res.ok)
    throw new Error(`${res.status}`);
}
function playbackNonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let out = "";
  for (let i = 0;i < 16; i++)
    out += alphabet[Math.floor(Math.random() * 64)];
  return out;
}
function panelTrack(v) {
  const credits = creditsOf(v.longBylineText?.runs);
  credits.duration = msOf(textOf(v.lengthText));
  return trackFrom(v.videoId, textOf(v.title), credits, imageOf(v.thumbnail));
}
async function stationNext() {
  let seed = host.storage.get("lastPlayed");
  if (!seed) {
    const { sections } = await home();
    seed = sections.flatMap((s) => s.tracks)[0]?.id;
    if (!seed)
      return [];
  }
  const answer = await call("next", { videoId: seed, playlistId: `RDAMVM${seed}`, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: "AUTOMIX_SETTING_NORMAL" });
  return findAll(answer, "playlistPanelVideoRenderer").filter((v) => v.videoId !== seed).map(panelTrack);
}
async function lyrics({ id }) {
  const next = await call("next", { videoId: id, isAudioOnly: true }, android);
  const playing = findAll(next, "playlistPanelVideoRenderer").find((v) => v.videoId === id);
  const [better, own] = await Promise.allSettled([
    playing ? betterLyrics(panelTrack(playing)) : null,
    youtubeLyrics(next)
  ]);
  if (better.status === "rejected")
    console.warn(`Better Lyrics: ${better.reason?.message}`);
  if (better.value?.lines.length)
    return better.value;
  if (own.status === "rejected")
    throw own.reason;
  return own.value;
}
async function betterLyrics(track) {
  const query = new URLSearchParams({ s: track.name, a: track.artists.map((a) => a.name).join(", ") });
  if (track.album.name)
    query.set("al", track.album.name);
  if (track.duration)
    query.set("d", String(Math.round(track.duration / 1000)));
  const res = await fetch(`https://api.betterlyrics.org/getLyrics?${query}`, {
    headers: { "user-agent": "MyGo Music (https://github.com/egoist/mygo-music)" }
  });
  if (!res.ok)
    return null;
  const lines = linesOfTTML((await res.json()).ttml || "");
  return lines.length ? { lines } : null;
}
var entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
var unescapeXML = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => e[0] !== "#" ? entities[e] ?? all : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
function clockOf(value) {
  if (!value)
    return null;
  const parts = value.trim().replace(/s$/, "").split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || !(Number(p) >= 0)))
    return null;
  return Math.round(parts.reduce((sum, p) => sum * 60 + Number(p), 0) * 1000);
}
var attrOf = (attrs, name) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
function linesOfTTML(ttml) {
  const lines = [];
  for (const [, pAttrs, body] of ttml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const words = [];
    let text = "";
    let lead = "";
    let word = null;
    let depth = 0;
    for (const [, close, name, attrs, chars] of body.matchAll(/<(\/?)([\w:.-]+)([^>]*?)\/?>|([^<]+)/g)) {
      if (chars !== undefined) {
        const s = unescapeXML(chars);
        text += s;
        if (word)
          word.text += s;
        else if (words.length)
          words[words.length - 1].text += s;
        else
          lead += s;
        continue;
      }
      if (name !== "span")
        continue;
      if (close) {
        if (word && --depth === 0) {
          words.push(word);
          word = null;
        }
      } else if (word) {
        depth++;
      } else {
        const start2 = clockOf(attrOf(attrs, "begin"));
        if (start2 === null)
          continue;
        word = { start: start2, end: clockOf(attrOf(attrs, "end")) ?? start2, text: lead.trimStart() };
        lead = "";
        depth = 1;
      }
    }
    const start = clockOf(attrOf(pAttrs, "begin")) ?? words[0]?.start;
    const end = clockOf(attrOf(pAttrs, "end")) ?? words[words.length - 1]?.end ?? 0;
    text = text.replace(/\s+/g, " ").trim();
    if (text && start != null)
      lines.push({ start, end, text, words: words.length ? words : undefined });
  }
  return lines;
}
async function youtubeLyrics(next) {
  const lyricsId = findAll(next, "browseId").find((b) => /^MPLY/.test(b));
  if (!lyricsId)
    return { lines: [] };
  const r = await call("browse", { browseId: lyricsId }, android);
  const timed = findOne(r, "timedLyricsData") || [];
  return {
    lines: timed.filter((l) => l.lyricLine).map((l) => ({
      start: Number(l.cueRange?.startTimeMilliseconds) || 0,
      end: Number(l.cueRange?.endTimeMilliseconds) || 0,
      text: l.lyricLine
    }))
  };
}
var located = new Map;
var locatedFor = 60 * 60 * 1000;
var visitor = "";
var extract = createExtractor((command, args) => host.spawn(command, args));
async function visitorData(signal) {
  if (visitor)
    return visitor;
  const r = await call("visitor_id", {}, { ...remix, anonymous: true }, signal);
  visitor = r.responseContext?.visitorData || "";
  if (!visitor)
    throw new Error(t("YouTube gave this visit no ID"));
  return visitor;
}
async function direct(id, signal) {
  const r = await call("player", { videoId: id, contentCheckOk: true, racyCheckOk: true }, visionOS(await visitorData(signal)), signal);
  const status = r.playabilityStatus || {};
  if (status.status !== "OK") {
    const why = status.reason || `YouTube says ${status.status || "nothing"} of this`;
    throw status.status === "UNPLAYABLE" || status.status === "ERROR" ? Object.assign(fail("unavailable", why), { terminalPlayability: true }) : new Error(why);
  }
  const formats = (r.streamingData?.adaptiveFormats || []).filter((f) => /^audio\/(mp4|webm)(?:;|$)/.test(f.mimeType || "") && f.url && !f.isDrc && (!f.audioTrack || f.audioTrack.audioIsDefault));
  const aac = formats.filter((f) => f.mimeType.startsWith("audio/mp4"));
  const best = (aac.length ? aac : formats).sort((a, b) => b.bitrate - a.bitrate)[0];
  if (!best)
    throw new Error(t("YouTube listed no audio to play as it is"));
  const type = best.mimeType.startsWith("audio/mp4") ? "m4a" : "webm";
  return {
    ...streamFromInfo({ url: best.url, protocol: "https", ext: type, acodec: type === "m4a" ? "aac" : "opus", vcodec: "none", http_headers: { "User-Agent": webUA } }),
    bitRate: best.bitrate,
    gain: gainOf(r.playerConfig?.audioConfig)
  };
}
function gainOf(audio) {
  const lkfs = audio?.trackAbsoluteLoudnessLkfs ?? audio?.perceptualLoudnessDb;
  if (typeof lkfs !== "number" || !lkfs)
    return;
  return Math.round((-18 - lkfs) * 100) / 100;
}
async function stream({ id }) {
  requireVideoID(id);
  const deadline = Date.now() + 25000;
  let known = located.get(id);
  if (known && Date.now() - known.at >= locatedFor) {
    located.delete(id);
    known = null;
  }
  if (known) {
    try {
      return await ready(known, fetch, Math.min(deadline, Date.now() + 1200), []);
    } catch {
      located.delete(id);
    }
  }
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), Math.min(6000, deadline - Date.now()));
  let source;
  try {
    source = await direct(id, controller.signal);
    source = await ready(source, fetch, Math.min(deadline, Date.now() + 1200), []);
  } catch (error) {
    if (error.terminalPlayability)
      throw error;
    visitor = "";
    source = { ...await extract(id, { deadline }), gain: source?.gain };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  source.at = Date.now();
  located.set(id, source);
  return source;
}
export {
  suggest,
  stream,
  stations,
  stationNext,
  signOut,
  signIn,
  search,
  recent,
  playlists,
  playlistPage as playlist,
  played,
  lyrics,
  liked,
  like,
  isLiked,
  home,
  browse,
  artistPage as artist,
  albumPage as album,
  account
};
