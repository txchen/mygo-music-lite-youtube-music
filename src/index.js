import { createPlugin } from './plugin.js';

const plugin = createPlugin(host);
export const search = plugin.search;
export const home = plugin.home;
export const browse = plugin.browse;
export const album = plugin.album;
export const artist = plugin.artist;
export const playlist = plugin.playlist;
export const playlists = plugin.playlists;
export const liked = plugin.liked;
export const isLiked = plugin.isLiked;
export const like = plugin.like;
export const stream = plugin.stream;
export const signIn = plugin.signIn;
export const signOut = plugin.signOut;
export const account = plugin.account;
