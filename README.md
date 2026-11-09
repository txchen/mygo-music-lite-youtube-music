# YouTube Music for MyGo Music Lite

A direct port of [the original YouTube Music plugin](https://github.com/egoist/mygo-music-youtube-music) for **MyGo Music Lite 0.3.0 on macOS Apple Silicon**. Version 0.2.0 restores the original plugin's catalog, account, history, radio, lyrics and Chinese translation. [UPSTREAM.md](UPSTREAM.md) records the exact source revision and Lite adaptations.

## Install

Open **Settings > Plugins > +** in Lite and install `txchen/mygo-music-lite-youtube-music`. You can also use [Install in MyGo Music Lite](mygo-music-lite://install-plugin?repo=txchen/mygo-music-lite-youtube-music). For a local installation, choose this repository's folder. Its `plugin.json`, built `index.js` and `locales` folder must be together.

Public audio normally uses the original plugin's direct YouTube lookup. Install the fallback dependencies if YouTube refuses that route.

```sh
brew install yt-dlp deno
```

The fallback searches `PATH`, `/opt/homebrew/bin` and `/usr/local/bin`. Reopen Lite after installing or upgrading the programs and allow the plugin to run them when prompted. No Node.js, Bun or ffmpeg is needed for playback. Bun is used only for development. Lite's optional `mpv` fallback can support audio formats its native engine cannot open.

`minAppVersion` remains `0.1.22`, Lite's retained plugin API baseline. This release targets Lite 0.3.0.

## Features

The port retains all twenty original plugin entry points.

- Home with its additional shelves, Charts and New Releases.
- Song, album, artist and playlist search, search suggestions and pagination.
- Album, artist and playlist details with the original response mapping.
- Google browser sign-in, account details, saved playlists, liked songs, like and unlike.
- Recent history, reporting signed-in playback to YouTube, and Radio based on the last played song.
- Timed lyrics from Better Lyrics with YouTube as fallback. The API retains word timing when available; Lite renders line-synced lyrics.
- The original Chinese translation and account, stations and liked navigation.

The original plugin does not implement uploads, downloads, podcast search or playlist editing.

## Playback

The original anonymous visitor/VISIONOS lookup finds a direct file without starting a subprocess. The Lite adapter prefers AAC/M4A, retains gain and bitrate, and returns the native URL, type and safe headers. It can also return WebM. It never transcodes or starts an ffmpeg HTTP server.

Addresses are cached for up to an hour. A small range request validates the container before each return. A stale cached address is replaced. A newly refused direct address uses yt-dlp instead. There is no unconditional readiness sleep. Temporary fallback CDN refusals retry within a shared 25-second resolution deadline. The same budget covers direct lookup, runtime discovery, extraction and readiness checks. Timed-out or noisy helpers are killed and reaped.

The yt-dlp fallback uses public access even while catalog sign-in is active. It accepts direct M4A/WebM audio files and rejects manifests, video, unexpected CDN hosts and unsafe headers. This differs from the original plugin's cookie-bearing HLS fallback, which required transcoding. Account-only, Premium-only, age-restricted and region-restricted audio can remain unavailable. Codec support depends on Lite's playback engine.

## Account and privacy

Sign-in retains the original Google page, YouTube session handoff, Safari identity on macOS and required session cookies. Upgrading from earlier Lite versions migrates the saved local session into the original plugin's `cookie` storage key. Signing out clears both keys and invalidates pending account requests or browser results.

Cookies are sensitive credentials stored locally in Lite's plugin storage. The original catalog and history code sends them only to YouTube. Signed-in playback is reported to YouTube Music and can change its history and recommendations, just as in the original plugin. The public audio fallback does not receive those cookies. It ignores user yt-dlp configuration and receives an empty stdin configuration. Audio CDN headers never include account credentials.

The manifest lists the JavaScript network hosts and the fallback executables. Process permissions permit yt-dlp and Deno to make their own operating-system network requests outside JavaScript's host allowlist.

Real Google browser sign-in and signed-in library/history actions require user account acceptance. Automated checks use synthetic cookies and temporary storage, without reading or mutating a real account.

## Development and verification

```sh
bun run build
bun test
```

`src/index.js` contains the original plugin with the Lite boundaries. `src/extractor.js` provides the bounded public fallback. `index.js` is the committed single-module bundle loaded by Lite and must be rebuilt after source changes.

Tests cover the retained entry points, migration and sign-out, the original browser handoff, native AAC selection and gain, direct playback without helpers, cached-address refresh, public fallback, radio seed persistence, timed lyrics, container validation, safe headers, deadlines, CDN retry and process cleanup. They do not require Google credentials.

Live public checks contact YouTube and use no account.

```sh
bun run smoke
bun run smoke:audio
MYGO_LITE_REPO=/path/to/mygo-music-lite bash scripts/verify-host.sh
```

The host verifier archives the committed host checkout into a temporary directory. It tests Home, Charts, New Releases, suggestions, radio, all four search kinds, pagination and detail pages through Lite's actual JavaScript runtime. Radio uses `played` with temporary unsigned storage, so it does not report to an account. The player check resolves a public video, measures stream resolution and native startup, then tests muted playback, pause, seek and resume. Set `MYGO_YOUTUBE_VIDEO` to choose another public video.

The verifier leaves the source checkout and app data untouched. It requires macOS, Go and Lite's native build dependencies. Set `MYGO_SIGN_IDENTITY` to test a hardened runtime signed with Lite's library-validation entitlement. Set `MYGO_SIGN_KEYCHAIN` when needed. The script signs only its temporary test binary.

Live service success depends on the item, region and current YouTube responses. Catalog, extraction and container checks alone do not prove native playback or real-account behavior.
