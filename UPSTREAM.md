# Upstream source

This plugin ports [egoist/mygo-music-youtube-music](https://github.com/egoist/mygo-music-youtube-music) at commit [`eb4e42abc22e5fbd04df691aa0633cdaa1ad7a63`](https://github.com/egoist/mygo-music-youtube-music/tree/eb4e42abc22e5fbd04df691aa0633cdaa1ad7a63).

`src/index.js` retains its catalog, response mapping, account sign-in, playlists, likes, history reporting, radio and lyrics implementation. `locales/zh-CN.json` and the navigation entries come from the same revision. The original plugin's twenty exported entry points are all retained.

Lite adaptations change the plugin ID, add the supported native playback CDN permissions, migrate the earlier Lite session storage, and prevent old account requests or a cancelled sign-in from restoring signed-out state. Audio keeps the upstream anonymous visitor ID and VISIONOS lookup and cache. It prefers AAC/M4A for native startup, checks the direct file, and recovers stale addresses. A bounded public-only yt-dlp/Deno fallback replaces the upstream ffmpeg streaming server and cookie-bearing HLS fallback.

The upstream repository contains no LICENSE file at this revision. This project does not invent a license or claim that the upstream author granted one.
