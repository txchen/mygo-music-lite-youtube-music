# YouTube Music for MyGo Music Lite

A JavaScript source plugin for **MyGo Music Lite 0.3.0 on macOS Apple Silicon**. Browse and search YouTube Music without signing in, then play public audio through Lite's native playback path.

This is an independent implementation for Lite. It uses YouTube Music's web API for catalog data and a bounded `yt-dlp` subprocess for fresh direct audio URLs. YouTube can change either interface.

## Install

Install the external audio dependencies with Homebrew.

```sh
brew install yt-dlp deno
```

Open **Settings > Plugins > +** in MyGo Music Lite and install from the GitHub repository `txchen/mygo-music-lite-youtube-music`. You can also use the [Install in MyGo Music Lite](mygo-music-lite://install-plugin?repo=txchen/mygo-music-lite-youtube-music) link.

For a local installation, choose the folder option and select this repository's folder. `plugin.json` and the built `index.js` must be at its top level. Allow the plugin to run the programs listed in its permission prompt.

The plugin looks for `yt-dlp` and `deno` on `PATH`, then in `/opt/homebrew/bin` and `/usr/local/bin`. Reopen Lite after installing or upgrading them. No Node.js or Bun installation is needed to use the plugin. Bun is only used for development.

Lite can use its optional mpv playback fallback if a native engine cannot open a container. Install it with `brew install mpv` if needed. The plugin does not start mpv itself.

`minAppVersion` is `0.1.22` because that field describes Lite's retained upstream plugin API baseline. The supported Lite release for this plugin is 0.3.0.

## Features

- Public Home, song search with pagination, and album, artist and playlist search.
- Album, artist and playlist details. Playlist song order and repeated occurrences are retained.
- Fresh direct public audio URLs on every play, preferring M4A and falling back to WebM.
- Browser sign-in, account details, saved playlists, liked songs, like and unlike actions. These account features have automated protocol tests, but have **not been verified against a real signed-in account**.

Lyrics, radio, podcast search, uploads, downloads and playlist editing are not implemented. The plugin does not advertise those capabilities to Lite.

### Audio limits

Lite accepts direct HTTP(S) audio files. This plugin rejects HLS, DASH, video formats, unexpected CDN hosts and formats outside M4A/WebM. It does not transcode or invoke ffmpeg. Codec support depends on Lite's selected native engine.

Audio extraction currently uses public access even after catalog sign-in. Account-only, Premium-only, age-restricted, region-restricted or otherwise unavailable items can fail. Signing in does not promise access to those audio files. YouTube can also refuse a CDN request after extraction succeeds.

Stream resolution has a 25-second total deadline, including finding Deno, extraction, and a small CDN range check. The plugin waits for HTTP 206 and valid container bytes before handing the URL to Lite. Temporary CDN refusals retry within that same budget. Every probe cancels its response body. A timed-out or excessively noisy subprocess is killed, drained and reaped. Missing dependencies and denied process permission open a setup error. Restricted extraction produces an unavailable error with no raw subprocess output.

If playback fails, update the dependencies with `brew upgrade yt-dlp deno` and try another public item. A successful search result does not guarantee playable public audio.

## Account and privacy

Sign in through the plugin's account action. Lite opens Google's page in its isolated sign-in browser. The plugin waits for the YouTube session cookies before checking the account with YouTube Music.

Version 0.1.1 corrects the macOS sign-in configuration to match the original YouTube Music plugin's working flow. It uses a Safari identity for Lite's WebKit browser, redirects through YouTube's session handoff, and waits for `SAPISID` and `__Secure-3PSID`. The automated tests cover this configuration. Real Google sign-in still needs user verification.

Account cookies are saved in Lite's plugin storage on this computer. They are sensitive credentials. The plugin sends them only to YouTube Music API requests that require the account. They are never passed to `yt-dlp`, printed by this plugin, added to process arguments, or returned as audio CDN headers. Public extraction starts with `--ignore-config` and an empty stdin configuration so a user's `yt-dlp` config cannot silently add cookies, downloads or postprocessors.

Sign out removes the stored session and account caches. Pending responses from an older account generation are rejected. Sign out affects this plugin's local session and does not revoke the Google account session elsewhere.

The plugin's own `fetch` requests are restricted to the manifest's YouTube Music and artwork/CDN hosts. The process permission lets the approved `yt-dlp` and Deno executables run with the listener's operating-system permissions. `yt-dlp` makes its own network requests outside the JavaScript fetch allowlist.

## Development and verification

```sh
bun run build
bun test
```

`src/` contains the catalog client, response mapping, account lifecycle and audio adapter. `index.js` is the committed single-module bundle that Lite loads. No runtime imports or dependencies are shipped. Run `bun run build` after source changes.

The tests exercise renderer parsing, repeated playlist entries, recommendation exclusion, pagination, account-generation isolation, authentication failure, direct-container validation, safe CDN headers, extractor timeout, output bounds and child cleanup. They use synthetic protocol fixtures and do not require Google credentials.

Live public checks are opt-in and contact YouTube.

```sh
bun run smoke
bun run smoke:audio
```

The catalog smoke opens Home, searches all four supported kinds, follows a song continuation, and opens an album, artist and playlist. The audio smoke extracts the public `aqz-KE-bpKQ` video, requests a small byte range, and checks HTTP 206 and its container signature. Pass another video ID as `bun run smoke:audio -- VIDEO_ID`. It never prints signed audio URLs or account cookies. These service checks can fail because of network, region or upstream changes.

Local verification covered the real public catalog, direct audio container bytes, and plugin loading through Lite's actual JavaScript host. A real public music video also passed native AVPlayer progress, pause, seek to 10 seconds, and resume after the CDN readiness check. Real account sign-in remains a separate acceptance step. Audio playback support must be judged per item and playback engine, not inferred from catalog or extraction success.

To repeat the catalog and native player checks through Lite's own runtime, use a local Lite 0.3.0 source checkout.

```sh
MYGO_LITE_REPO=/path/to/mygo-music-lite bash scripts/verify-host.sh
```

The script archives that checkout's committed `HEAD` into a temporary directory and adds the opt-in tests in `test/host/`. It leaves the source checkout and app data untouched. It requires macOS, Go, the host's native build dependencies, yt-dlp, and Deno. The native check uses public video `5NV6Rdv1a3I`, muted playback, pause, seek, and resume. Set `MYGO_YOUTUBE_VIDEO` to choose another public video.

The default test binary is unsigned. To test Apple's hardened runtime, also set `MYGO_SIGN_IDENTITY` to your available code-signing identity. Set `MYGO_SIGN_KEYCHAIN` if that identity uses a non-default keychain. The script signs the temporary player test binary with the library-validation entitlement used by Lite and removes it afterwards. It does not sign or install the app.
