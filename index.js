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

// src/sha1.js
function sha1(text) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(size);
  data.set(bytes);
  data[bytes.length] = 128;
  const view = new DataView(data.buffer);
  view.setUint32(size - 4, bytes.length * 8);
  const h = [1732584193, 4023233417, 2562383102, 271733878, 3285377520];
  const w = new Int32Array(80);
  const rotate = (n, b) => n << b | n >>> 32 - b;
  for (let block = 0;block < size; block += 64) {
    for (let i = 0;i < 16; i++)
      w[i] = view.getInt32(block + i * 4);
    for (let i = 16;i < 80; i++)
      w[i] = rotate(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0;i < 80; i++) {
      const f = i < 20 ? b & c | ~b & d : i < 40 ? b ^ c ^ d : i < 60 ? b & c | b & d | c & d : b ^ c ^ d;
      const k = i < 20 ? 1518500249 : i < 40 ? 1859775393 : i < 60 ? 2400959708 : 3395469782;
      const next = rotate(a, 5) + f + e + k + w[i] | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    [a, b, c, d, e].forEach((value, i) => {
      h[i] = h[i] + value | 0;
    });
  }
  return h.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

// src/client.js
var ORIGIN = "https://music.youtube.com";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
function cookieValue(cookie, name) {
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(name + "="))?.slice(name.length + 1) || "";
}
function authHeaders(cookie, now = Date.now()) {
  if (/[\r\n\0]/.test(cookie))
    throw failure("signIn", "The saved sign-in is invalid. Sign in again.");
  const sapisid = cookieValue(cookie, "SAPISID") || cookieValue(cookie, "__Secure-3PAPISID");
  if (!sapisid)
    throw failure("signIn", "Sign in to YouTube Music first.");
  const timestamp = Math.floor(now / 1000);
  return { cookie, authorization: `SAPISIDHASH ${timestamp}_${sha1(`${timestamp} ${sapisid} ${ORIGIN}`)}`, "x-goog-authuser": "0", "x-origin": ORIGIN };
}
function createClient({ fetch: fetcher = fetch, session, language = () => "en" }) {
  let config;
  let bootstrapPromise;
  async function read(url, options, deadline) {
    const controller = new AbortController;
    const remaining = Math.min(1e4, deadline - Date.now());
    if (remaining <= 0)
      throw failure("unavailable", "YouTube Music took too long to answer. Try again.");
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetcher(url, { ...options, signal: controller.signal });
      if (response.status === 401 || response.status === 403)
        throw failure(options.signed ? "signIn" : "unavailable", options.signed ? "Your YouTube Music sign-in expired. Sign in again." : "YouTube Music refused this request. Try again later.");
      if (!response.ok)
        throw failure("unavailable", `YouTube Music returned HTTP ${response.status}. Try again later.`);
      const body = await response.text();
      if (body.length > 12 * 1024 * 1024)
        throw failure("unavailable", "YouTube Music returned an oversized response.");
      return body;
    } catch (error) {
      if (isFailure(error))
        throw error;
      throw failure("unavailable", controller.signal.aborted ? "YouTube Music took too long to answer. Try again." : "Could not reach YouTube Music. Check your connection.");
    } finally {
      clearTimeout(timer);
    }
  }
  async function bootstrap(deadline) {
    if (config)
      return config;
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        const html = await read(ORIGIN + "/", { headers: { "user-agent": USER_AGENT } }, deadline);
        const version = html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1];
        const visitor = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] || "";
        if (!version)
          throw failure("unavailable", "YouTube Music could not initialize. Its website may have changed.");
        config = { version, visitor };
        return config;
      })().finally(() => {
        bootstrapPromise = null;
      });
    }
    return bootstrapPromise;
  }
  async function request(endpoint, body = {}, { signed = false, cookie, deadline = Date.now() + 24000 } = {}) {
    const generation = session.generation;
    const credentials = cookie === undefined ? session.cookie : cookie;
    if (signed && !credentials)
      throw failure("signIn", "Sign in to YouTube Music first.");
    const initial = await bootstrap(deadline);
    if (generation !== session.generation)
      throw failure("unavailable", "Your account changed. Open this page again.");
    const headers = { "content-type": "application/json", "user-agent": USER_AGENT, origin: ORIGIN, "x-youtube-client-name": "67", "x-youtube-client-version": initial.version };
    if (initial.visitor)
      headers["x-goog-visitor-id"] = initial.visitor;
    if (signed)
      Object.assign(headers, authHeaders(credentials));
    const context = { client: { clientName: "WEB_REMIX", clientVersion: initial.version, hl: language() === "zh-CN" ? "zh-CN" : "en", gl: "US", visitorData: initial.visitor }, user: { lockedSafetyMode: false } };
    const raw = await read(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, { method: "POST", headers, body: JSON.stringify({ ...body, context }), signed }, deadline);
    if (generation !== session.generation)
      throw failure("unavailable", "Your account changed. Open this page again.");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw failure("unavailable", "YouTube Music returned an unreadable response.");
    }
    if (data.error)
      throw failure(data.error.code === 401 || data.error.code === 403 ? "signIn" : "unavailable", "YouTube Music could not complete this request.");
    if (signed && data.responseContext?.mainAppWebResponseContext?.loggedOut === true)
      throw failure("signIn", "Your YouTube Music sign-in expired. Sign in again.");
    return data;
  }
  return { request };
}

// src/mapping.js
function text(value) {
  return typeof value === "string" ? value : value?.simpleText || (value?.runs || []).map((run) => run.text || "").join("");
}
function nodes(root, key) {
  const found = [];
  function visit(value) {
    if (!value || typeof value !== "object")
      return;
    if (value[key]) {
      found.push(value[key]);
      return;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child))
        child.forEach(visit);
      else
        visit(child);
    }
  }
  visit(root);
  return found;
}
function image(value) {
  const list = nodes(value, "thumbnails").flat();
  return list.filter((t) => t?.url).sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || "";
}
function duration(value) {
  const match = String(value).match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match)
    return 0;
  const parts = match.slice(1).filter((x) => x !== undefined).map(Number);
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
}
function browseEndpoint(value) {
  return value?.navigationEndpoint?.browseEndpoint || value?.browseEndpoint;
}
function pageType(endpoint) {
  return endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || "";
}
function credits(runs, type) {
  return runs.flatMap((run) => {
    const endpoint = browseEndpoint(run);
    if (!endpoint || !pageType(endpoint).includes(type))
      return [];
    return [{ id: endpoint.browseId, name: run.text || "" }];
  });
}
function toTrack(item) {
  const columns = (item.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text || {});
  const title = columns[0] || item.title || {};
  const runs = columns.slice(1).flatMap((c) => c.runs || []).concat(item.subtitle?.runs || []);
  const watch = title.runs?.find((r) => r.navigationEndpoint?.watchEndpoint)?.navigationEndpoint?.watchEndpoint || item.navigationEndpoint?.watchEndpoint || item.playlistItemData || nodes(item.overlay, "watchEndpoint")[0] || {};
  const id = watch.videoId;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || ""))
    return null;
  const album = credits(runs, "ALBUM")[0] || { id: "", name: "" };
  album.imageUrl = image(item.thumbnail || item);
  const times = runs.map((r) => r.text).concat((item.fixedColumns || []).map((c) => text(c.musicResponsiveListItemFixedColumnRenderer?.text)));
  return {
    id,
    name: text(title),
    artists: credits(runs, "ARTIST"),
    album,
    duration: times.map(duration).find((n) => n > 0) || 0,
    url: `https://music.youtube.com/watch?v=${id}`,
    unavailable: item.musicItemRendererDisplayPolicy === "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT"
  };
}
function toEntity(item, kind) {
  const title = item.title || item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const endpoint = browseEndpoint(item) || title?.runs?.map(browseEndpoint).find(Boolean);
  if (!endpoint?.browseId)
    return null;
  const id = endpoint.browseId;
  const type = pageType(endpoint);
  if (kind === "albums" && !type.includes("ALBUM") && !id.startsWith("MPRE"))
    return null;
  if (kind === "artists" && !type.includes("ARTIST") && !id.startsWith("UC"))
    return null;
  if (kind === "playlists" && !type.includes("PLAYLIST") && !id.startsWith("VL"))
    return null;
  const result = { id, name: text(title), imageUrl: image(item.thumbnailRenderer || item.thumbnail || item) };
  const runs = item.subtitle?.runs || item.flexColumns?.slice(1).flatMap((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []) || [];
  if (kind === "albums")
    result.artists = credits(runs, "ARTIST");
  if (kind === "playlists")
    result.owner = credits(runs, "USER_CHANNEL")[0]?.name || "";
  return result;
}
function items(root, kind = "tracks", unique = true) {
  const renderers = [...nodes(root, "musicResponsiveListItemRenderer"), ...nodes(root, "musicTwoRowItemRenderer")];
  const mapped = renderers.map((item) => kind === "tracks" ? toTrack(item) : toEntity(item, kind)).filter(Boolean);
  if (!unique)
    return mapped;
  const seen = new Set;
  return mapped.filter((item) => !seen.has(item.id) && seen.add(item.id));
}
function continuation(root) {
  const next = nodes(root, "nextContinuationData")[0] || nodes(root, "reloadContinuationData")[0];
  return next?.continuation || nodes(root, "continuationCommand")[0]?.token || "";
}
function header(root) {
  const value = nodes(root, "musicResponsiveHeaderRenderer")[0] || nodes(root, "musicDetailHeaderRenderer")[0] || nodes(root, "musicImmersiveHeaderRenderer")[0] || nodes(root, "musicVisualHeaderRenderer")[0] || {};
  return { name: text(value.title), imageUrl: image(value.thumbnail || value), description: text(value.description), artists: credits(value.subtitle?.runs || [], "ARTIST") };
}
function browseSections(root) {
  const shelves = [...nodes(root, "musicCarouselShelfRenderer"), ...nodes(root, "musicShelfRenderer"), ...nodes(root, "musicPlaylistShelfRenderer")];
  return shelves.map((shelf) => {
    const section = { title: text(shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title || shelf.title) };
    for (const kind of ["tracks", "albums", "artists", "playlists"]) {
      const list = items(shelf.contents || shelf, kind);
      if (list.length)
        section[kind] = list;
    }
    return section;
  }).filter((s) => s.tracks?.length || s.albums?.length || s.artists?.length || s.playlists?.length);
}

// src/catalog.js
var SEARCH_PARAMS = {
  tracks: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
  albums: "EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D",
  artists: "EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D",
  playlists: "EgWKAQIoAWoKEAkQChAFEAMQBA%3D%3D"
};
function collectionParts(response) {
  const shelves = nodes(response, "musicPlaylistShelfRenderer");
  const continuations = nodes(response, "musicPlaylistShelfContinuation");
  const musicShelves = nodes(response, "musicShelfRenderer");
  const contents = shelves.length ? shelves : continuations.length ? continuations : musicShelves.length ? musicShelves : response;
  return { tracks: items(contents, "tracks", false), token: continuation(contents) };
}
function createCatalog(client, session) {
  const searches = new Map;
  const likes = new Map;
  let likedPages;
  function clear() {
    searches.clear();
    likes.clear();
    likedPages = undefined;
  }
  async function paged(state, offset, fetchPage, kind, deadline) {
    if (!Number.isInteger(offset) || offset < 0)
      throw failure("unavailable", "Invalid page offset.");
    while (!state.started || state.values.length <= offset && state.token) {
      if (Date.now() >= deadline)
        throw failure("unavailable", "This page took too long to load. Try again.");
      const previous = state.token;
      const response = await fetchPage(state.token);
      const list = items(response, kind);
      const seen = new Set(state.values.map((item) => item.id));
      state.values.push(...list.filter((item) => !seen.has(item.id) && seen.add(item.id)));
      state.token = continuation(response);
      state.started = true;
      if (state.token === previous || !list.length && state.token)
        state.token = "";
      if (state.values.length > 5000)
        throw failure("unavailable", "This collection is too large to load in one session.");
    }
    const values = state.values.slice(offset, offset + 25);
    return { [kind]: values, more: offset + values.length < state.values.length || Boolean(state.token) };
  }
  const pageState = () => ({ started: false, values: [], token: "" });
  async function search({ query, kind = "tracks", offset = 0 }) {
    if (!SEARCH_PARAMS[kind])
      throw failure("unsupported", "YouTube Music search supports songs, albums, artists and playlists.");
    if (typeof query !== "string" || !query.trim())
      return { [kind]: [], more: false };
    const key = JSON.stringify([session.generation, query, kind]);
    if (!searches.has(key) || offset === 0)
      searches.set(key, pageState());
    if (searches.size > 20)
      searches.delete(searches.keys().next().value);
    const deadline = Date.now() + 24000;
    return paged(searches.get(key), offset, (token) => client.request("search", token ? { continuation: token } : { query, params: SEARCH_PARAMS[kind] }, { signed: Boolean(session.cookie), deadline }), kind, deadline);
  }
  async function browseData(id, deadline = Date.now() + 24000, signed = Boolean(session.cookie)) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw failure("unavailable", "Invalid YouTube Music page.");
    return client.request("browse", { browseId: id }, { signed, deadline });
  }
  async function collection(id) {
    const deadline = Date.now() + 24000;
    const response = await browseData(id, deadline, id === "VLLM" || Boolean(session.cookie));
    const initial = collectionParts(response);
    const tracks = initial.tracks;
    let token = initial.token;
    while (token) {
      if (Date.now() > deadline - 1000)
        throw failure("unavailable", "This playlist is too large to load now. Try a smaller collection.");
      const next = await client.request("browse", { continuation: token }, { signed: Boolean(session.cookie), deadline });
      const part = collectionParts(next);
      tracks.push(...part.tracks);
      const nextToken = part.token;
      if (nextToken === token)
        throw failure("unavailable", "YouTube Music repeated a playlist page.");
      token = nextToken;
      if (tracks.length > 5000)
        throw failure("unavailable", "This playlist is too large to load.");
    }
    return { response, tracks, detail: header(response) };
  }
  async function home() {
    const response = await browseData("FEmusic_home");
    const sections = browseSections(response);
    if (!sections.length)
      throw failure("unavailable", "YouTube Music returned no home sections. Try search or sign in.");
    return { title: "YouTube Music", sections };
  }
  async function playlist({ id }) {
    const browseID = id.startsWith("VL") ? id : "VL" + id;
    const { detail, tracks } = await collection(browseID);
    return { id, name: detail.name || "Playlist", imageUrl: detail.imageUrl, description: detail.description, trackCount: tracks.length, tracks, fixed: browseID === "VLLM" };
  }
  async function album({ id }) {
    const { detail, tracks } = await collection(id);
    const album2 = { id, name: detail.name || tracks[0]?.album.name || "Album", imageUrl: detail.imageUrl || tracks[0]?.album.imageUrl, artists: detail.artists };
    return { album: album2, tracks: tracks.map((track) => ({ ...track, album: album2, artists: track.artists.length ? track.artists : album2.artists })) };
  }
  async function artist({ id }) {
    const response = await browseData(id);
    const detail = header(response);
    return { artist: { id, name: detail.name || "Artist", imageUrl: detail.imageUrl }, tracks: items(response), albums: items(response, "albums") };
  }
  async function libraryData() {
    return browseData("FEmusic_liked_playlists", Date.now() + 24000, true);
  }
  async function playlists() {
    return items(await libraryData(), "playlists").map((p) => ({ ...p, saved: true }));
  }
  async function browse({ page }) {
    if (page !== "library")
      throw failure("unsupported", "This YouTube Music page is not available.");
    const sections = browseSections(await libraryData());
    return { title: "Library", sections: sections.length ? sections : [{ title: "Playlists", empty: "Your saved playlists will appear here." }] };
  }
  async function liked({ offset = 0 }) {
    if (!session.cookie)
      throw failure("signIn", "Sign in to see your liked songs.");
    if (!likedPages || offset === 0)
      likedPages = pageState();
    const deadline = Date.now() + 24000;
    const result = await paged(likedPages, offset, (token) => client.request("browse", token ? { continuation: token } : { browseId: "VLLM" }, { signed: true, deadline }), "tracks", deadline);
    for (const track of result.tracks)
      likes.set(track.id, true);
    return result;
  }
  async function isLiked({ ids }) {
    if (!session.cookie)
      return Object.fromEntries(ids.map((id) => [id, false]));
    const unknown = ids.filter((id) => !likes.has(id));
    if (unknown.length) {
      const deadline = Date.now() + 24000;
      for (let i = 0;i < unknown.length; i += 50) {
        const response = await client.request("music/get_queue", { videoIds: unknown.slice(i, i + 50) }, { signed: true, deadline });
        for (const renderer of nodes(response, "playlistPanelVideoRenderer")) {
          const status = nodes(renderer, "likeButtonRenderer")[0]?.likeStatus;
          const action = nodes(renderer, "toggleMenuServiceItemRenderer").map((item) => item.defaultServiceEndpoint?.likeEndpoint?.status).find(Boolean);
          if (!renderer.videoId || !status && !action)
            continue;
          likes.set(renderer.videoId, status ? status === "LIKE" : action === "INDIFFERENT");
        }
      }
      if (unknown.some((id) => !likes.has(id)))
        throw failure("unavailable", "YouTube Music did not return the liked status of this song.");
    }
    return Object.fromEntries(ids.map((id) => [id, likes.get(id) === true]));
  }
  async function like({ id, on }) {
    requireVideoID(id);
    await client.request(on ? "like/like" : "like/removelike", { target: { videoId: id } }, { signed: true });
    likes.set(id, Boolean(on));
    likedPages = undefined;
  }
  return { clear, search, home, browse, playlist, album, artist, playlists, liked, isLiked, like };
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
async function ready(stream, fetcher, deadline, retryDelays) {
  let attempt = 0;
  while (Date.now() < deadline) {
    const controller = new AbortController;
    const timer = setTimeout(() => controller.abort(), Math.min(3000, deadline - Date.now()));
    let response;
    let retry = false;
    try {
      response = await fetcher(stream.url, { headers: { ...stream.headers, Range: "bytes=0-511" }, signal: controller.signal, redirect: "error" });
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
          return stream;
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
  return async function extract(id) {
    requireVideoID(id);
    const deadline = Date.now() + timeout;
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

// src/plugin.js
function createPlugin(host2, fetcher = fetch) {
  const stored = host2.storage.get("session");
  const session = { cookie: typeof stored?.cookie === "string" ? stored.cookie : "", account: stored?.account || null, generation: 0 };
  const client = createClient({ fetch: fetcher, session, language: () => host2.language() });
  const catalog = createCatalog(client, session);
  const extract = createExtractor((command, args) => host2.spawn(command, args), { fetch: fetcher });
  const search = (params) => catalog.search(params);
  const home = () => catalog.home();
  const browse = (params) => catalog.browse(params);
  const album = (params) => catalog.album(params);
  const artist = (params) => catalog.artist(params);
  const playlist = (params) => catalog.playlist(params);
  const playlists = () => catalog.playlists();
  const liked = (params) => catalog.liked(params);
  const isLiked = (params) => catalog.isLiked(params);
  const like = (params) => catalog.like(params);
  const stream = ({ id }) => extract(id);
  function readAccount(response) {
    const active = nodes(response, "activeAccountHeaderRenderer")[0];
    if (!active || !text(active.accountName))
      throw failure("signIn", "YouTube Music did not confirm this account. Sign in again.");
    return { id: text(active.channelHandle) || text(active.email) || "youtube-account", name: text(active.accountName), imageUrl: image(active.accountPhoto), page: "library" };
  }
  async function signIn() {
    const generation = ++session.generation;
    catalog.clear();
    const result = await host2.webSignIn({ url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F", cookiesOf: "https://music.youtube.com", until: ["__Secure-3PAPISID"], userAgent: USER_AGENT });
    if (generation !== session.generation)
      throw failure("signIn", "This sign-in was cancelled.");
    if (!result?.cookie || /[\r\n\0]/.test(result.cookie))
      throw failure("signIn", "YouTube Music did not return a valid sign-in.");
    const response = await client.request("account/account_menu", {}, { signed: true, cookie: result.cookie });
    if (generation !== session.generation)
      throw failure("signIn", "This sign-in was cancelled.");
    const account2 = readAccount(response);
    session.generation++;
    catalog.clear();
    session.cookie = result.cookie;
    session.account = account2;
    host2.storage.set("session", { cookie: session.cookie, account: account2 });
    return account2;
  }
  function signOut() {
    session.generation++;
    session.cookie = "";
    session.account = null;
    catalog.clear();
    host2.storage.remove("session");
  }
  async function account() {
    if (!session.cookie)
      return null;
    const response = await client.request("account/account_menu", {}, { signed: true });
    session.account = readAccount(response);
    return session.account;
  }
  return { search, home, browse, album, artist, playlist, playlists, liked, isLiked, like, stream, signIn, signOut, account };
}

// src/index.js
var plugin = createPlugin(host);
var search = plugin.search;
var home = plugin.home;
var browse = plugin.browse;
var album = plugin.album;
var artist = plugin.artist;
var playlist = plugin.playlist;
var playlists = plugin.playlists;
var liked = plugin.liked;
var isLiked = plugin.isLiked;
var like = plugin.like;
var stream = plugin.stream;
var signIn = plugin.signIn;
var signOut = plugin.signOut;
var account = plugin.account;
export {
  stream,
  signOut,
  signIn,
  search,
  playlists,
  playlist,
  liked,
  like,
  isLiked,
  home,
  browse,
  artist,
  album,
  account
};
