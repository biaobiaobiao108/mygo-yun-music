// YunLu Music for MyGo Music.
//
// The plugin talks to a self-hosted YunLu Music server through its HTTP API.
// It keeps the server address and account in MyGo's plugin settings, and the
// session cookies and recently seen songs in the plugin's own data directory.

const SEARCH_PAGE = 30;
const LIST_PAGE = 100;
const PLAYLIST_CAP = 500;
const META_CAP = 1000;
const LIST_TTL = 15_000;
const LIBRARY_TTL = 60_000;
const BOARDS_TTL = 10 * 60_000;
const CONFIG_TTL = 5 * 60_000;

function setting(key) {
  return String(host.setting(key) || "");
}

function tr(text) {
  return host.t(text);
}

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

let authState = null;
let songState = null;
let configCache = { at: 0, data: null };
let listCache = { at: 0, data: null, pending: null };
let libraryCache = {
  albums: { at: 0, data: null, pending: null },
  artists: { at: 0, data: null, pending: null },
};
let boardsCache = { source: "", at: 0, data: null, pending: null };
let discoverCache = { source: "", at: 0, data: null, pending: null };

function auth() {
  if (!authState) {
    const saved = host.storage.get("auth");
    authState = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  if (!authState.playerCookie) authState.playerCookie = "";
  if (!authState.userCookie) authState.userCookie = "";
  if (authState.signedOut !== true) authState.signedOut = false;
  return authState;
}

function saveAuth() {
  host.storage.set("auth", auth());
}

function songs() {
  if (!songState) {
    const saved = host.storage.get("songs");
    songState = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  return songState;
}

function saveSongs() {
  host.storage.set("songs", songs());
}

function resetAuth() {
  authState = { playerCookie: "", userCookie: "", signedOut: false };
  saveAuth();
}

function resetSongs() {
  songState = {};
  host.storage.remove("songs");
}

function emptySlot() {
  return { at: 0, data: null, pending: null };
}

function clearCaches() {
  configCache = { at: 0, data: null };
  listCache = emptySlot();
  libraryCache = { albums: emptySlot(), artists: emptySlot() };
  boardsCache = { source: "", at: 0, data: null, pending: null };
  discoverCache = { source: "", at: 0, data: null, pending: null };
}

function clearListCache() {
  listCache = emptySlot();
}

function serverBase() {
  let raw = setting("server").trim();
  if (!raw) throw fail("setup", tr("Set the server address in the plugin's settings."));
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  raw = raw.replace(/\/+$/, "").replace(/\/music$/i, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail("setup", tr("The server address isn't a valid http or https address."));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw fail("setup", tr("The server address isn't a valid http or https address."));
  }
  return raw;
}

function sourceId() {
  return setting("source").trim().toLowerCase() === "tx" ? "tx" : "wy";
}

function username() {
  return setting("username").trim();
}

function password() {
  return setting("password");
}

function playerPassword() {
  return setting("playerPassword");
}

function hasAccount() {
  return Boolean(username() && password());
}

function stripSourcePrefix(value, source) {
  let text = String(value ?? "");
  if (source && text.startsWith(`${source}_`)) text = text.slice(source.length + 1);
  return text;
}

function songMeta(song) {
  return song && song.meta && typeof song.meta === "object" ? song.meta : {};
}

function songSource(song) {
  return String(song?.source ?? songMeta(song).source ?? "").trim();
}

function rawSongmid(song) {
  const meta = songMeta(song);
  return stripSourcePrefix(
    song?.songmid ?? meta.songmid ?? meta.songId ?? song?.songId ?? song?.id ?? song?.hash ?? "",
    songSource(song),
  );
}

function trackIdFor(song) {
  const source = songSource(song);
  const mid = rawSongmid(song);
  return source && mid ? `t:${source}:${mid}` : "";
}

function parseTrackId(id) {
  const text = String(id ?? "");
  const at = text.startsWith("t:") ? text.indexOf(":", 2) : -1;
  if (at < 3) throw fail("unavailable", tr("The server didn't return a playable address."));
  return { source: text.slice(2, at), songmid: text.slice(at + 1) };
}

function albumIdFor(source, id) {
  return `al:${source}:${id}`;
}

function albumNameId(source, name) {
  return `al:${source}:n:${encodeURIComponent(name)}`;
}

function artistIdFor(source, id) {
  return `ar:${source}:${id}`;
}

function artistNameId(source, name) {
  return `ar:${source}:n:${encodeURIComponent(name)}`;
}

function playlistIdFor(source, id) {
  return `p:${source}:${id}`;
}

function boardIdFor(source, id) {
  return `b:${source}:${id}`;
}

function userListId(id) {
  return `u:${id}`;
}

function parseEntityId(id, prefix) {
  const text = String(id ?? "");
  if (!text.startsWith(`${prefix}:`)) return null;
  const rest = text.slice(prefix.length + 1);
  const at = rest.indexOf(":");
  if (at < 1) return null;
  const source = rest.slice(0, at);
  const tail = rest.slice(at + 1);
  if (tail.startsWith("n:")) return { source, raw: "", name: decodeURIComponent(tail.slice(2)) };
  return { source, raw: tail, name: "" };
}

function parseUserListId(id) {
  const text = String(id ?? "");
  return text.startsWith("u:") ? text.slice(2) : "";
}

function songKey(song) {
  const source = songSource(song);
  const mid = rawSongmid(song);
  return source && mid ? `${source}:${mid}` : "";
}

function musicInfoId(song) {
  const meta = songMeta(song);
  return String(song?.id ?? song?.songmid ?? song?.hash ?? meta.songId ?? meta.songmid ?? "").trim();
}

function rememberSongs(list) {
  if (!Array.isArray(list) || !list.length) return;
  const cache = songs();
  let changed = false;
  for (const song of list) {
    if (!song || typeof song !== "object") continue;
    const id = trackIdFor(song);
    if (!id) continue;
    delete cache[id];
    cache[id] = song;
    changed = true;
  }
  if (!changed) return;
  const keys = Object.keys(cache);
  const extra = keys.length - META_CAP;
  for (let i = 0; i < extra; i += 1) delete cache[keys[i]];
  saveSongs();
}

function lookupSong(id) {
  const song = songs()[id];
  return song && typeof song === "object" ? song : null;
}

function songForList(song) {
  const copy = { ...song };
  if (!musicInfoId(copy)) {
    const mid = rawSongmid(copy);
    if (mid) copy.id = mid;
  }
  return copy;
}

function splitArtistNames(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => (item && typeof item === "object" ? item.name ?? item.singer ?? "" : item))
      .map(item => String(item ?? "").trim())
      .filter(Boolean);
  }
  return String(value ?? "")
    .split(/[、,，;；&|]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function toArtists(value, source) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (item && typeof item === "object") {
        const name = String(item.name ?? item.singer ?? "").trim();
        if (!name) continue;
        const raw = item.id ?? item.artistId ?? item.singerId ?? item.mid ?? "";
        out.push({
          id: raw ? artistIdFor(source, stripSourcePrefix(raw, source)) : artistNameId(source, name),
          name,
        });
      } else {
        const name = String(item ?? "").trim();
        if (name) out.push({ id: artistNameId(source, name), name });
      }
    }
    return out;
  }
  return splitArtistNames(value).map(name => ({ id: artistNameId(source, name), name }));
}

function parseInterval(value) {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value).trim();
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number > 10000 ? Math.round(number) : Math.round(number * 1000);
  }
  const parts = text.split(":").map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return 0;
}

function dateOnly(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function webUrl(source, songmid) {
  if (!songmid) return "";
  if (source === "wy") return `https://music.163.com/#/song?id=${encodeURIComponent(songmid)}`;
  if (source === "tx") return `https://y.qq.com/n/yqq/song/${encodeURIComponent(songmid)}.html`;
  return "";
}

function firstSongImage(list) {
  const first = Array.isArray(list) ? list[0] : null;
  return first?.img ?? first?.picUrl ?? first?.meta?.picUrl ?? first?.album?.picUrl ?? first?.album?.img ?? "";
}

function toTrack(song) {
  const source = songSource(song);
  const meta = songMeta(song);
  const name = String(song?.name ?? meta.name ?? song?.title ?? "").trim();
  const artistValue = Array.isArray(song?.artists) && song.artists.length ? song.artists : song?.singer ?? meta.singer;
  const artists = toArtists(artistValue, source);
  const albumName = String(song?.albumName ?? meta.albumName ?? song?.album?.name ?? "").trim();
  const albumRaw = song?.albumId ?? meta.albumId ?? song?.album?.id ?? "";
  const image = String(song?.img ?? song?.picUrl ?? meta.picUrl ?? song?.album?.picUrl ?? "").trim();
  const album = {
    id: albumRaw ? albumIdFor(source, stripSourcePrefix(albumRaw, source)) : albumName ? albumNameId(source, albumName) : "",
    name: albumName,
    imageUrl: image,
  };
  if (artists.length) album.artists = artists.slice(0, 1);
  return {
    id: trackIdFor(song),
    name,
    artists,
    album,
    duration: parseInterval(song?.interval ?? meta.interval),
    url: webUrl(source, rawSongmid(song)),
  };
}

function toAlbum(item, source) {
  const raw = item?.id ?? item?.albumId ?? item?.albumMid ?? item?.mid ?? "";
  const name = String(item?.name ?? item?.albumName ?? "").trim();
  const image = String(item?.picUrl ?? item?.img ?? item?.cover ?? item?.album?.picUrl ?? "").trim();
  const artistName = String(item?.artistName ?? item?.singer ?? "").trim();
  const artistRaw = item?.artistId ?? item?.artistMid ?? item?.singerId ?? item?.singerMid ?? "";
  const artists = artistName
    ? [{ id: artistRaw ? artistIdFor(source, stripSourcePrefix(artistRaw, source)) : artistNameId(source, artistName), name: artistName }]
    : [];
  return {
    id: raw !== "" ? albumIdFor(source, stripSourcePrefix(raw, source)) : name ? albumNameId(source, name) : "",
    name,
    imageUrl: image,
    artists,
    released: dateOnly(item?.publishTime ?? item?.released ?? item?.aDate),
  };
}

function toArtist(item, source) {
  const raw = item?.id ?? item?.artistId ?? item?.artistMid ?? item?.mid ?? "";
  const name = String(item?.name ?? item?.singer ?? "").trim();
  const image = String(item?.picUrl ?? item?.avatar ?? item?.img ?? "").trim();
  return {
    id: raw !== "" ? artistIdFor(source, stripSourcePrefix(raw, source)) : name ? artistNameId(source, name) : "",
    name,
    imageUrl: image,
  };
}

function toPlaylist(item, source) {
  const raw = item?.id ?? item?.listId ?? item?.dissid ?? "";
  const count = Number(item?.trackCount ?? item?.total ?? item?.songCount ?? 0);
  return {
    id: raw !== "" ? playlistIdFor(source, raw) : "",
    name: String(item?.name ?? "").trim(),
    imageUrl: String(item?.picUrl ?? item?.img ?? item?.cover ?? "").trim(),
    description: String(item?.desc ?? item?.description ?? "").trim(),
    owner: String(item?.creator ?? item?.author ?? item?.nickname ?? "").trim(),
    trackCount: Number.isFinite(count) && count > 0 ? count : undefined,
  };
}

function toBoard(board, source) {
  const raw = board?.bangid ?? board?.id ?? "";
  return {
    id: boardIdFor(source, raw),
    name: String(board?.name ?? "").trim(),
    description: tr("Chart"),
  };
}

function toUserPlaylist(item) {
  const list = Array.isArray(item?.list) ? item.list : [];
  const count = Number(item?.trackCount ?? list.length);
  return {
    id: userListId(String(item?.id ?? "")),
    name: String(item?.name ?? "").trim(),
    imageUrl: String(item?.img ?? firstSongImage(list)).trim(),
    trackCount: Number.isFinite(count) && count > 0 ? count : undefined,
    mine: !item?.source,
    saved: Boolean(item?.source),
  };
}

function toComment(item) {
  let time = Number(item?.time) || 0;
  if (time > 0 && time < 1e12) time *= 1000;
  return {
    id: String(item?.id ?? ""),
    author: String(item?.userName ?? item?.author ?? "").trim(),
    avatarUrl: String(item?.avatar ?? item?.avatarUrl ?? "").trim(),
    text: String(item?.text ?? ""),
    time,
    likes: Number(item?.likedCount ?? item?.likes ?? 0) || 0,
    liked: Boolean(item?.liked),
  };
}

function cookieHeader() {
  const state = auth();
  return [state.playerCookie, state.userCookie].filter(Boolean).join("; ");
}

async function raw(path, options = {}) {
  const base = serverBase();
  let url = base + path;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const query = params.toString();
    if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
  }
  const headers = {};
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error(tr("Couldn't reach the server. Check the address and network."));
  }
  let text = "";
  try {
    text = await response.text();
  } catch {}
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, ok: response.ok, data, text, headers: response.headers };
}

function setCookie(headers, name) {
  let lines = [];
  if (headers && typeof headers.getSetCookie === "function") {
    try {
      lines = headers.getSetCookie();
    } catch {}
  }
  if (!lines.length && headers && typeof headers.get === "function") {
    const value = headers.get("set-cookie");
    if (value) lines = [value];
  }
  for (const line of lines) {
    const first = String(line).split(";")[0].trim();
    if (first.startsWith(`${name}=`)) return first;
  }
  return "";
}

function decode(result) {
  if (result.ok) return result.data !== null ? result.data : result.text;
  const message =
    String(result.data?.message ?? result.data?.error ?? result.text ?? "").trim() || `HTTP ${result.status}`;
  if (result.status === 401) throw fail("signIn", message);
  if (result.status === 403 || result.status === 404 || result.status === 422 || result.status === 429) {
    throw fail("unavailable", message);
  }
  throw new Error(message);
}

async function serverConfig() {
  if (configCache.data && Date.now() - configCache.at < CONFIG_TTL) return configCache.data;
  const result = await raw("/api/music/config");
  if (!result.ok) throw decode(result);
  const data = result.data && typeof result.data === "object" ? result.data : {};
  configCache = { at: Date.now(), data: { playerAuth: Boolean(data["player.enableAuth"]) } };
  return configCache.data;
}

async function loginPlayer() {
  const value = playerPassword();
  if (!value) throw fail("setup", tr("This server asks for a player password. Set it in the plugin's settings."));
  const result = await raw("/api/music/auth", { method: "POST", body: { password: value } });
  if (!result.ok) {
    const message =
      String(result.data?.message ?? result.data?.error ?? result.text ?? "").trim() || tr("Couldn't log in to the server.");
    throw fail(result.status === 401 ? "signIn" : "setup", message);
  }
  const cookie = setCookie(result.headers, "lx_player_session");
  if (!cookie) throw new Error(tr("The server didn't set a session cookie."));
  auth().playerCookie = cookie;
  saveAuth();
}

async function ensurePlayer() {
  const config = await serverConfig();
  if (!config.playerAuth) return;
  if (auth().playerCookie) return;
  if (!playerPassword()) {
    throw fail("setup", tr("This server asks for a player password. Set it in the plugin's settings."));
  }
  await loginPlayer();
}

async function loginUser() {
  if (!hasAccount()) throw fail("setup", tr("Set your YunLu Music account in the plugin's settings."));
  const result = await raw("/api/user/login", {
    method: "POST",
    body: { username: username(), password: password() },
  });
  if (!result.ok) {
    clearUserCookie();
    const message =
      String(result.data?.message ?? result.data?.error ?? result.text ?? "").trim() || tr("Couldn't log in to the server.");
    throw fail("signIn", message);
  }
  const cookie = setCookie(result.headers, "lx_user_session");
  if (!cookie) throw new Error(tr("The server didn't set a session cookie."));
  auth().userCookie = cookie;
  auth().signedOut = false;
  saveAuth();
  return String(result.data?.username || username());
}

async function ensureUser() {
  if (!hasAccount()) return null;
  const state = auth();
  if (state.signedOut) return null;
  if (state.userCookie) {
    const result = await raw("/api/user/auth/verify");
    if (result.ok && result.data && result.data.valid) return String(result.data.username || username());
    clearUserCookie();
  }
  return loginUser();
}

function clearPlayerCookie() {
  auth().playerCookie = "";
  saveAuth();
}

function clearUserCookie() {
  auth().userCookie = "";
  saveAuth();
}

async function api(path, options = {}) {
  const retried = Boolean(options.retried);
  const needsUser =
    options.user !== undefined ? Boolean(options.user) : path.startsWith("/api/user") || path.includes("/user/");
  if (path.startsWith("/api/music")) await ensurePlayer();
  if (needsUser) {
    const name = await ensureUser();
    if (!name) throw fail("signIn", tr("Sign in to YunLu Music first."));
  }
  const request = { ...options };
  delete request.user;
  delete request.retried;
  const result = await raw(path, request);
  if (result.status === 401 && !retried) {
    if (path.startsWith("/api/music")) {
      clearPlayerCookie();
      await loginPlayer();
    }
    if (needsUser) {
      clearUserCookie();
      await loginUser();
    }
    return api(path, { ...options, retried: true });
  }
  return decode(result);
}

async function userList(force = false) {
  if (!force && listCache.data && Date.now() - listCache.at < LIST_TTL) return listCache.data;
  if (listCache.pending) return listCache.pending;
  const pending = api("/api/user/list", { user: true }).then(
    data => {
      listCache = { at: Date.now(), data, pending: null };
      return data;
    },
    error => {
      listCache.pending = null;
      throw error;
    },
  );
  listCache = { ...listCache, pending };
  return pending;
}

async function library(kind, force = false) {
  const slot = libraryCache[kind];
  if (!force && slot.data && Date.now() - slot.at < LIBRARY_TTL) return slot.data;
  if (slot.pending) return slot.pending;
  const pending = api(`/api/user/library/${kind}`, { user: true }).then(
    data => {
      const list = Array.isArray(data) ? data : [];
      slot.data = list;
      slot.at = Date.now();
      slot.pending = null;
      return list;
    },
    error => {
      slot.pending = null;
      throw error;
    },
  );
  slot.pending = pending;
  return pending;
}

function setLibrary(kind, list) {
  const slot = libraryCache[kind];
  slot.data = list;
  slot.at = Date.now();
  slot.pending = null;
}

async function boardsFor(source) {
  if (boardsCache.data && boardsCache.source === source && Date.now() - boardsCache.at < BOARDS_TTL) {
    return boardsCache.data;
  }
  if (boardsCache.pending) return boardsCache.pending;
  const pending = api("/api/music/leaderboard/boards", { query: { source } }).then(
    data => {
      const list = Array.isArray(data?.list) ? data.list : [];
      const mapped = list.map(item => toBoard(item, source));
      boardsCache = { source, at: Date.now(), data: mapped, pending: null };
      return mapped;
    },
    error => {
      boardsCache.pending = null;
      throw error;
    },
  );
  boardsCache = { ...boardsCache, pending };
  return pending;
}

async function discoverFor(source) {
  if (discoverCache.data && discoverCache.source === source && Date.now() - discoverCache.at < BOARDS_TTL) {
    return discoverCache.data;
  }
  if (discoverCache.pending) return discoverCache.pending;
  const pending = api("/api/music/songList/list", { query: { source, page: 1 } }).then(
    data => {
      const list = Array.isArray(data?.list) ? data.list : [];
      const mapped = list.map(item => toPlaylist(item, source));
      discoverCache = { source, at: Date.now(), data: mapped, pending: null };
      return mapped;
    },
    error => {
      discoverCache.pending = null;
      throw error;
    },
  );
  discoverCache = { ...discoverCache, pending };
  return pending;
}

function albumRaw(item) {
  const source = String(item?.source || sourceId()).trim() || sourceId();
  return { source, raw: stripSourcePrefix(item?.albumId ?? item?.albumMid ?? item?.id ?? item?.mid ?? "", source) };
}

function artistRaw(item) {
  const source = String(item?.source || sourceId()).trim() || sourceId();
  return {
    source,
    raw: stripSourcePrefix(
      item?.artistId ?? item?.artistMid ?? item?.singerId ?? item?.singerMid ?? item?.id ?? item?.mid ?? "",
      source,
    ),
  };
}

async function savedAlbumKeys() {
  if (!hasAccount()) return new Set();
  try {
    const items = await library("albums");
    const keys = new Set();
    for (const item of items) {
      const info = albumRaw(item);
      if (info.raw) keys.add(`${info.source}:${info.raw}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

async function followedArtistKeys() {
  if (!hasAccount()) return new Set();
  try {
    const items = await library("artists");
    const keys = new Set();
    for (const item of items) {
      const info = artistRaw(item);
      if (info.raw) keys.add(`${info.source}:${info.raw}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

async function savedPlaylistKeys() {
  if (!hasAccount()) return new Set();
  try {
    const data = await userList();
    const keys = new Set();
    for (const item of data.userList || []) {
      if (item.source && item.sourceListId) keys.add(`${item.source}:${item.sourceListId}`);
    }
    return keys;
  } catch {
    return new Set();
  }
}

function sameAlbum(item, source, raw, name) {
  const info = albumRaw(item);
  if (info.source !== source) return false;
  if (raw && info.raw && String(info.raw) === String(raw)) return true;
  return Boolean(name && String(item?.name ?? item?.albumName ?? "").trim() === name);
}

function sameArtist(item, source, raw, name) {
  const info = artistRaw(item);
  if (info.source !== source) return false;
  if (raw && info.raw && String(info.raw) === String(raw)) return true;
  return Boolean(name && String(item?.name ?? item?.singer ?? "").trim() === name);
}

async function isSavedAlbum(source, raw) {
  const keys = await savedAlbumKeys();
  return keys.has(`${source}:${raw}`);
}

async function isFollowedArtist(source, raw) {
  const keys = await followedArtistKeys();
  return keys.has(`${source}:${raw}`);
}

async function isSavedPlaylist(source, raw) {
  const keys = await savedPlaylistKeys();
  return keys.has(`${source}:${raw}`);
}

async function albumPage(id) {
  const parsed = parseEntityId(id, "al");
  if (!parsed) throw fail("unavailable", tr("The album wasn't found."));
  const source = parsed.source;
  let raw = parsed.raw;
  let name = parsed.name;
  let image = "";
  let artists = [];
  let released = "";
  if (!raw && name) {
    const list = await api("/api/music/search", {
      query: { name, source, type: "album", limit: 10, page: 1 },
    });
    const first = Array.isArray(list) ? list[0] : null;
    if (!first) throw fail("unavailable", tr("No matching album found."));
    raw = String(first.id ?? first.albumId ?? first.albumMid ?? "").trim();
    name = String(first.name ?? name);
    image = String(first.picUrl ?? first.img ?? "");
    const artistName = String(first.artistName ?? first.singer ?? "").trim();
    const artistRaw = first.artistId ?? first.artistMid ?? "";
    artists = artistName
      ? [
          {
            id: artistRaw ? artistIdFor(source, stripSourcePrefix(artistRaw, source)) : artistNameId(source, artistName),
            name: artistName,
          },
        ]
      : [];
    released = dateOnly(first.publishTime);
  }
  if (!raw) throw fail("unavailable", tr("The album wasn't found."));
  const data = await api("/api/music/albumSongs", { query: { source, id: raw } });
  const list = Array.isArray(data?.list) ? data.list : [];
  rememberSongs(list);
  const first = list[0] || null;
  const album = {
    id: albumIdFor(source, raw),
    name: String(data?.name || name || first?.albumName || first?.meta?.albumName || "").trim(),
    imageUrl: String(image || first?.img || first?.meta?.picUrl || "").trim(),
    artists: artists.length ? artists : toArtists(first?.singer ?? first?.artists, source),
    released: dateOnly(data?.publishTime) || released,
  };
  album.saved = await isSavedAlbum(source, raw);
  return { album, tracks: list.map(toTrack) };
}

async function artistPage(id) {
  const parsed = parseEntityId(id, "ar");
  if (!parsed) throw fail("unavailable", tr("The artist wasn't found."));
  const source = parsed.source;
  let raw = parsed.raw;
  let name = parsed.name;
  let image = "";
  if (!raw && name) {
    const list = await api("/api/music/search", {
      query: { name, source, type: "singer", limit: 10, page: 1 },
    });
    const first = Array.isArray(list) ? list[0] : null;
    if (!first) throw fail("unavailable", tr("No matching artist found."));
    raw = String(first.id ?? first.artistId ?? first.artistMid ?? "").trim();
    name = String(first.name ?? name);
    image = String(first.picUrl ?? first.avatar ?? first.img ?? "");
  }
  if (!raw) throw fail("unavailable", tr("The artist wasn't found."));
  const [detail, firstPage, secondPage, albums] = await Promise.all([
    api("/api/music/artistDetail", { query: { source, id: raw } }),
    api("/api/music/artistSongs", { query: { source, id: raw, page: 1, limit: LIST_PAGE, order: "hot" } }),
    api("/api/music/artistSongs", { query: { source, id: raw, page: 2, limit: LIST_PAGE, order: "hot" } }).catch(
      () => null,
    ),
    api("/api/music/artistAlbums", { query: { source, id: raw, page: 1, limit: LIST_PAGE } }).catch(() => null),
  ]);
  const songs = [];
  for (const page of [firstPage, secondPage]) {
    if (page && Array.isArray(page.list)) songs.push(...page.list);
  }
  const unique = [];
  const seen = new Set();
  for (const song of songs) {
    const key = songKey(song);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(song);
    if (unique.length >= 200) break;
  }
  rememberSongs(unique);
  const artist = {
    id: artistIdFor(source, raw),
    name: String(detail?.name || name || "").trim(),
    imageUrl: String(detail?.avatar || image || "").trim(),
  };
  artist.following = await isFollowedArtist(source, raw);
  const albumItems = albums && Array.isArray(albums.list) ? albums.list : [];
  return { artist, tracks: unique.map(toTrack), albums: albumItems.map(item => toAlbum(item, source)) };
}

async function onlinePlaylist(source, raw) {
  let all = [];
  let total = 0;
  let info = {};
  for (let page = 1; page <= 5; page += 1) {
    let data;
    try {
      data = await api("/api/music/songList/detail", {
        query: { source, id: raw, page, limit: LIST_PAGE },
      });
    } catch (error) {
      if (!all.length) throw error;
      break;
    }
    const list = Array.isArray(data?.list) ? data.list : [];
    all = all.concat(list);
    total = Number(data?.total) || all.length;
    if (data?.info && typeof data.info === "object") info = data.info;
    if (list.length < LIST_PAGE || all.length >= total || all.length >= PLAYLIST_CAP) break;
  }
  rememberSongs(all);
  return { info, songs: all.slice(0, PLAYLIST_CAP), total };
}

async function boardDetail(source, raw) {
  let all = [];
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    let data;
    try {
      data = await api("/api/music/leaderboard/list", {
        query: { source, bangid: raw, page, limit: LIST_PAGE },
      });
    } catch (error) {
      if (!all.length) throw error;
      break;
    }
    const list = Array.isArray(data?.list) ? data.list : [];
    all = all.concat(list);
    total = Number(data?.total) || all.length;
    if (list.length < LIST_PAGE || all.length >= total || all.length >= PLAYLIST_CAP) break;
  }
  rememberSongs(all);
  const boards = await boardsFor(source).catch(() => []);
  const board = boards.find(item => {
    const parsed = parseEntityId(item.id, "b");
    return parsed && String(parsed.raw) === String(raw);
  });
  return { name: board?.name || tr("Chart"), songs: all.slice(0, PLAYLIST_CAP), total };
}

export async function setSetting({ key }) {
  const name = String(key || "");
  if (name === "server") {
    resetAuth();
    resetSongs();
    clearCaches();
    return;
  }
  if (name === "username" || name === "password" || name === "playerPassword") {
    resetAuth();
    clearCaches();
    return;
  }
  if (name === "source") clearCaches();
}

export async function signIn() {
  if (!hasAccount()) throw fail("setup", tr("Set your YunLu Music account in the plugin's settings."));
  auth().signedOut = false;
  saveAuth();
  await ensurePlayer();
  const name = await loginUser();
  return { id: name, name };
}

export async function signOut() {
  const state = auth();
  if (state.userCookie) {
    try {
      await raw("/api/user/logout", { method: "POST" });
    } catch {}
  }
  state.userCookie = "";
  state.signedOut = true;
  saveAuth();
  clearCaches();
}

export async function account() {
  try {
    const name = await ensureUser();
    return name ? { id: name, name } : null;
  } catch (error) {
    if (error && error.code === "signIn") return null;
    throw error;
  }
}

export async function search({ query, kind, offset }) {
  const source = sourceId();
  const text = String(query || "");
  const start = Math.max(0, Number(offset) || 0);
  const page = Math.floor(start / SEARCH_PAGE) + 1;
  if (kind === "tracks") {
    const list = await api("/api/music/search", {
      query: { name: text, source, type: "song", limit: SEARCH_PAGE, page },
    });
    const items = Array.isArray(list) ? list : [];
    rememberSongs(items);
    return { tracks: items.map(toTrack), more: items.length >= SEARCH_PAGE };
  }
  if (kind === "albums") {
    const list = await api("/api/music/search", {
      query: { name: text, source, type: "album", limit: SEARCH_PAGE, page },
    });
    const items = Array.isArray(list) ? list : [];
    const saved = await savedAlbumKeys();
    return {
      albums: items.map(item => {
        const album = toAlbum(item, source);
        const parsed = parseEntityId(album.id, "al");
        album.saved = Boolean(parsed && saved.has(`${parsed.source}:${parsed.raw}`));
        return album;
      }),
      more: items.length >= SEARCH_PAGE,
    };
  }
  if (kind === "artists") {
    const list = await api("/api/music/search", {
      query: { name: text, source, type: "singer", limit: SEARCH_PAGE, page },
    });
    const items = Array.isArray(list) ? list : [];
    const following = await followedArtistKeys();
    return {
      artists: items.map(item => {
        const artist = toArtist(item, source);
        const parsed = parseEntityId(artist.id, "ar");
        artist.following = Boolean(parsed && following.has(`${parsed.source}:${parsed.raw}`));
        return artist;
      }),
      more: items.length >= SEARCH_PAGE,
    };
  }
  if (kind === "playlists") {
    const data = await api("/api/music/songList/search", {
      query: { text, source, page, limit: SEARCH_PAGE },
    });
    const items = Array.isArray(data?.list) ? data.list : [];
    const total = Number(data?.total) || 0;
    const saved = await savedPlaylistKeys();
    return {
      playlists: items.map(item => {
        const playlist = toPlaylist(item, source);
        const parsed = parseEntityId(playlist.id, "p");
        playlist.saved = Boolean(parsed && saved.has(`${parsed.source}:${parsed.raw}`));
        return playlist;
      }),
      more: total ? start + items.length < total : items.length >= SEARCH_PAGE,
    };
  }
  if (kind === "shows") return { shows: [], more: false };
  return { more: false };
}

export async function suggest({ query }) {
  const source = sourceId();
  try {
    const tips = await api("/api/music/tipSearch", { query: { name: String(query || ""), source } });
    return Array.isArray(tips) ? tips.map(String).filter(Boolean).slice(0, 10) : [];
  } catch {
    return [];
  }
}

export async function home() {
  const source = sourceId();
  const sections = [];
  if (hasAccount()) {
    try {
      const tracks = await recent();
      if (tracks.length) sections.push({ title: tr("Recently Played"), tracks: tracks.slice(0, 10), morePage: "recent" });
    } catch {}
    try {
      const lists = await playlists();
      if (lists.length) sections.push({ title: tr("Your Playlists"), playlists: lists.slice(0, 12), morePage: "playlists" });
    } catch {}
  }
  const results = await Promise.all([
    boardsFor(source).then(value => ({ value, error: null }), error => ({ value: [], error })),
    discoverFor(source).then(value => ({ value, error: null }), error => ({ value: [], error })),
  ]);
  const boards = results[0].value;
  const discover = results[1].value;
  if (boards.length) sections.push({ title: tr("Charts"), playlists: boards.slice(0, 12), morePage: "charts" });
  if (discover.length) sections.push({ title: tr("Discover"), playlists: discover.slice(0, 12), morePage: "discover" });
  if (!sections.length) {
    const error = results.find(result => result.error)?.error;
    if (error) throw error;
    throw fail("unavailable", tr("Nothing to show from this server yet."));
  }
  return { sections };
}

export async function browse({ page }) {
  const source = sourceId();
  const name = String(page || "");
  if (name === "recent") return { title: tr("Recently Played"), sections: [{ tracks: await recent() }] };
  if (name === "playlists") return { title: tr("Your Playlists"), sections: [{ playlists: await playlists() }] };
  if (name === "charts") return { title: tr("Charts"), sections: [{ playlists: await boardsFor(source) }] };
  if (name === "discover") return { title: tr("Discover"), sections: [{ playlists: await discoverFor(source) }] };
  throw fail("unavailable", tr("No such page."));
}

export async function album({ id }) {
  return albumPage(id);
}

export async function artist({ id }) {
  return artistPage(id);
}

export async function playlists() {
  if (!hasAccount()) return [];
  const data = await userList();
  return (data.userList || []).map(toUserPlaylist);
}

export async function playlist({ id }) {
  const text = String(id || "");
  if (text.startsWith("u:")) {
    const raw = parseUserListId(text);
    const data = await userList();
    const item = (data.userList || []).find(entry => String(entry.id) === raw);
    if (!item) throw fail("unavailable", tr("The playlist wasn't found."));
    const list = Array.isArray(item.list) ? item.list : [];
    rememberSongs(list);
    // The web player lists a playlist the listener made newest first, and an
    // imported one in its source's order.
    const ordered = item.source ? list : list.slice().reverse();
    return { ...toUserPlaylist(item), tracks: ordered.map(toTrack) };
  }
  const online = parseEntityId(text, "p");
  if (online) {
    const detail = await onlinePlaylist(online.source, online.raw);
    return {
      id: text,
      name: String(detail.info.name || tr("Playlist")),
      imageUrl: String(detail.info.img || ""),
      description: String(detail.info.desc || ""),
      owner: String(detail.info.author || ""),
      trackCount: detail.total || detail.songs.length,
      saved: await isSavedPlaylist(online.source, online.raw),
      tracks: detail.songs.map(toTrack),
    };
  }
  const board = parseEntityId(text, "b");
  if (board) {
    const detail = await boardDetail(board.source, board.raw);
    return {
      id: text,
      name: detail.name,
      description: tr("Chart"),
      trackCount: detail.total || detail.songs.length,
      saved: await isSavedPlaylist(board.source, board.raw),
      tracks: detail.songs.map(toTrack),
    };
  }
  throw fail("unavailable", tr("The playlist wasn't found."));
}

export async function createPlaylist({ name }) {
  const clean = String(name || "").trim();
  if (!clean) throw fail("unavailable", tr("The playlist name is empty."));
  const id = `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await api("/api/user/playlists", {
    method: "POST",
    user: true,
    body: { action: "create", playlist: { id, name: clean, icon: "music", list: [], locationUpdateTime: null } },
  });
  clearListCache();
  return { id: userListId(id), name: clean, mine: true, trackCount: 0, tracks: [] };
}

export async function renamePlaylist({ id, name }) {
  const raw = parseUserListId(id);
  if (!raw) throw fail("unavailable", tr("The playlist wasn't found."));
  const clean = String(name || "").trim();
  if (!clean) throw fail("unavailable", tr("The playlist name is empty."));
  await api("/api/user/playlists", { method: "POST", user: true, body: { action: "rename", id: raw, name: clean } });
  clearListCache();
}

export async function deletePlaylist({ id }) {
  const raw = parseUserListId(id);
  if (!raw) throw fail("unavailable", tr("The playlist wasn't found."));
  await api("/api/user/playlists", { method: "POST", user: true, body: { action: "delete", id: raw } });
  clearListCache();
}

export async function addToPlaylist({ id, trackIds }) {
  const raw = parseUserListId(id);
  if (!raw) throw fail("unavailable", tr("The playlist wasn't found."));
  const songs = [];
  for (const trackId of trackIds || []) {
    const song = lookupSong(trackId);
    if (song) songs.push(songForList(song));
  }
  if (!songs.length) throw fail("unavailable", tr("Search for this song again before adding it to a playlist."));
  await api("/api/music/user/list/add", {
    method: "POST",
    user: true,
    body: { listId: raw, musicInfos: songs },
  });
  clearListCache();
}

export async function removeFromPlaylist({ id, trackIds }) {
  const raw = parseUserListId(id);
  if (!raw) throw fail("unavailable", tr("The playlist wasn't found."));
  const data = await userList(true);
  const item = (data.userList || []).find(entry => String(entry.id) === raw);
  if (!item) throw fail("unavailable", tr("The playlist wasn't found."));
  const keys = new Set();
  for (const trackId of trackIds || []) {
    try {
      const parsed = parseTrackId(trackId);
      keys.add(`${parsed.source}:${parsed.songmid}`);
    } catch {}
  }
  const songIds = (item.list || []).filter(song => keys.has(songKey(song))).map(musicInfoId).filter(Boolean);
  if (!songIds.length) return;
  await api("/api/music/user/list/remove", {
    method: "POST",
    user: true,
    body: { listId: raw, songIds },
  });
  clearListCache();
}

export async function movePlaylistTrack({ id, from, to }) {
  const raw = parseUserListId(id);
  if (!raw) throw fail("unavailable", tr("The playlist wasn't found."));
  const data = JSON.parse(JSON.stringify(await userList(true)));
  const item = (data.userList || []).find(entry => String(entry.id) === raw);
  if (!item || !Array.isArray(item.list)) throw fail("unavailable", tr("The playlist wasn't found."));
  const own = !item.source;
  const list = own ? item.list.slice().reverse() : item.list.slice();
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  if (start < 0 || start >= list.length || end < 0 || end > list.length || start === end) return;
  const [moved] = list.splice(start, 1);
  list.splice(end, 0, moved);
  item.list = own ? list.reverse() : list;
  await api("/api/user/list", { method: "POST", user: true, body: data });
  clearListCache();
}

export async function savePlaylist({ id, on }) {
  const text = String(id || "");
  const parsed = parseEntityId(text, "p") || parseEntityId(text, "b");
  if (!parsed) throw fail("unavailable", tr("The playlist wasn't found."));
  const data = await userList(true);
  const existing = (data.userList || []).find(
    item => String(item.source || "") === parsed.source && String(item.sourceListId || "") === String(parsed.raw),
  );
  if (on && existing) return;
  if (!on) {
    if (!existing) return;
    await api("/api/user/playlists", { method: "POST", user: true, body: { action: "delete", id: existing.id } });
    clearListCache();
    return;
  }
  const page = await playlist({ id: text });
  const songs = page.tracks.map(track => lookupSong(track.id)).filter(Boolean).map(songForList);
  if (!songs.length) throw fail("unavailable", tr("The playlist has no tracks."));
  const listId = `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await api("/api/user/playlists", {
    method: "POST",
    user: true,
    body: {
      action: "toggle",
      playlist: {
        id: listId,
        name: page.name,
        source: parsed.source,
        sourceListId: parsed.raw,
        img: page.imageUrl,
        list: songs,
        locationUpdateTime: null,
      },
    },
  });
  clearListCache();
}

export async function liked({ offset }) {
  const data = await userList();
  const all = Array.isArray(data.loveList) ? data.loveList.slice().reverse() : [];
  const start = Math.max(0, Number(offset) || 0);
  const page = all.slice(start, start + LIST_PAGE);
  rememberSongs(page);
  return { tracks: page.map(toTrack), more: start + LIST_PAGE < all.length };
}

export async function isLiked({ ids }) {
  const data = await userList();
  const keys = new Set((data.loveList || []).map(songKey).filter(Boolean));
  const out = {};
  for (const id of ids || []) {
    let key = "";
    try {
      const parsed = parseTrackId(id);
      key = `${parsed.source}:${parsed.songmid}`;
    } catch {}
    out[id] = Boolean(key && keys.has(key));
  }
  return out;
}

export async function like({ id, on }) {
  const parsed = parseTrackId(id);
  const key = `${parsed.source}:${parsed.songmid}`;
  const data = await userList(true);
  const love = Array.isArray(data.loveList) ? data.loveList : [];
  const existing = love.find(song => songKey(song) === key);
  if (on && !existing) {
    const song = lookupSong(id);
    if (!song) throw fail("unavailable", tr("Search for this song again before liking it."));
    await api("/api/music/user/list/add", {
      method: "POST",
      user: true,
      body: { listId: "love", musicInfos: [songForList(song)] },
    });
    clearListCache();
  } else if (!on && existing) {
    await api("/api/music/user/list/remove", {
      method: "POST",
      user: true,
      body: { listId: "love", songIds: [musicInfoId(existing)] },
    });
    clearListCache();
  }
}

export async function recent() {
  const data = await api("/api/user/play-history", { user: true });
  const items = Array.isArray(data?.items) ? data.items.slice(0, 50) : [];
  rememberSongs(items);
  return items.map(toTrack);
}

export async function played({ id }) {
  if (!hasAccount() || auth().signedOut) return;
  const song = lookupSong(id);
  if (!song) return;
  const item = { ...songForList(song), playedAt: Date.now() };
  try {
    await api("/api/user/play-history/events", {
      method: "POST",
      user: true,
      body: { events: [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, song: item }] },
    });
  } catch (error) {
    if (error?.code !== "unavailable") return;
    try {
      await api("/api/user/play-history", { method: "POST", user: true, body: { items: [item] } });
    } catch {}
  }
}

function toLibraryAlbum(item) {
  const source = String(item?.source || sourceId()).trim() || sourceId();
  const raw = stripSourcePrefix(item?.albumId ?? item?.albumMid ?? item?.id ?? item?.mid ?? "", source);
  const name = String(item?.name ?? item?.albumName ?? "").trim();
  return {
    id: raw ? albumIdFor(source, raw) : albumNameId(source, name),
    name,
    imageUrl: String(item?.picUrl ?? item?.img ?? "").trim(),
    artists: toArtists(item?.singer ?? item?.artistName, source),
    released: dateOnly(item?.publishTime),
    saved: true,
  };
}

export async function savedAlbums({ offset }) {
  const items = await library("albums");
  const start = Math.max(0, Number(offset) || 0);
  const page = items.slice(start, start + LIST_PAGE);
  return { albums: page.map(toLibraryAlbum), more: start + LIST_PAGE < items.length };
}

export async function saveAlbum({ id, on }) {
  const parsed = parseEntityId(id, "al");
  if (!parsed) throw fail("unavailable", tr("The album wasn't found."));
  if (on) {
    const page = await albumPage(id);
    const real = parseEntityId(page.album.id, "al");
    if (!real) throw fail("unavailable", tr("The album wasn't found."));
    const items = [...(await library("albums", true))];
    if (items.some(item => sameAlbum(item, real.source, real.raw, page.album.name))) return;
    items.push({
      id: real.raw,
      name: page.album.name,
      albumName: page.album.name,
      singer: (page.album.artists || []).map(artist => artist.name).join("、"),
      picUrl: page.album.imageUrl,
      source: real.source,
    });
    await api("/api/user/library/albums", { method: "POST", user: true, body: items });
    setLibrary("albums", items);
    return;
  }
  const items = [...(await library("albums", true))];
  const next = items.filter(item => !sameAlbum(item, parsed.source, parsed.raw, parsed.name));
  if (next.length === items.length) return;
  await api("/api/user/library/albums", { method: "POST", user: true, body: next });
  setLibrary("albums", next);
}

export async function followArtist({ id, on }) {
  const parsed = parseEntityId(id, "ar");
  if (!parsed) throw fail("unavailable", tr("The artist wasn't found."));
  if (on) {
    const page = await artistPage(id);
    const real = parseEntityId(page.artist.id, "ar");
    if (!real) throw fail("unavailable", tr("The artist wasn't found."));
    const items = [...(await library("artists", true))];
    if (items.some(item => sameArtist(item, real.source, real.raw, page.artist.name))) return;
    items.push({
      id: real.raw,
      name: page.artist.name,
      singer: page.artist.name,
      picUrl: page.artist.imageUrl,
      source: real.source,
    });
    await api("/api/user/library/artists", { method: "POST", user: true, body: items });
    setLibrary("artists", items);
    return;
  }
  const items = [...(await library("artists", true))];
  const next = items.filter(item => !sameArtist(item, parsed.source, parsed.raw, parsed.name));
  if (next.length === items.length) return;
  await api("/api/user/library/artists", { method: "POST", user: true, body: next });
  setLibrary("artists", next);
}

export async function lyrics({ id }) {
  const parsed = parseTrackId(id);
  const song = lookupSong(id);
  const data = await api("/api/music/lyric", {
    query: {
      source: parsed.source,
      songmid: parsed.songmid,
      name: song?.name || "",
      singer: song?.singer || song?.meta?.singer || "",
    },
  });
  return {
    lrc: String(data?.lyric ?? data?.lrc ?? ""),
    translation: String(data?.tlyric ?? data?.translation ?? ""),
  };
}

export async function comments({ trackId, offset }) {
  const parsed = parseTrackId(trackId);
  const song = lookupSong(trackId) || { source: parsed.source, songmid: parsed.songmid };
  const start = Math.max(0, Number(offset) || 0);
  const page = Math.floor(start / 20) + 1;
  const data = await api("/api/music/comment", {
    method: "POST",
    body: { songInfo: song, type: "all", page, limit: 20 },
  });
  const total = Number(data?.total) || 0;
  return {
    comments: Array.isArray(data?.comments) ? data.comments.map(toComment) : [],
    total,
    more: page * 20 < total,
  };
}

function qualityAttempts(quality) {
  const level = String(quality || "").toLowerCase();
  if (level === "lossless") return [{ quality: "flac", level: "lossless" }, { quality: "320k", level: "high" }];
  if (level === "standard") return [{ quality: "128k", level: "standard" }];
  return [{ quality: "320k", level: "high" }, { quality: "128k", level: "standard" }];
}

function audioType(url, quality) {
  const path = String(url).split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".flac")) return "flac";
  if (path.endsWith(".mp3")) return "mp3";
  if (path.endsWith(".ogg") || path.endsWith(".oga")) return "ogg";
  if (/\.(m4a|aac|opus|wav|ape)$/.test(path)) return "";
  return quality === "flac" ? "flac" : "mp3";
}

function streamUrl(rawUrl, type, song, data) {
  const base = serverBase();
  if (rawUrl.startsWith("/")) return base + rawUrl;
  if (rawUrl.startsWith("//")) return `${base.split(":")[0]}:${rawUrl}`;
  const token = String(data?.downloadToken ?? "").trim();
  if (!token) return rawUrl;
  const name = `${String(song?.name || "audio").trim() || "audio"}.${type}`;
  return `${base}/api/music/download?url=${encodeURIComponent(rawUrl)}&token=${encodeURIComponent(token)}&inline=1&filename=${encodeURIComponent(name)}`;
}

export async function stream({ id, quality }) {
  const parsed = parseTrackId(id);
  let song = lookupSong(id);
  if (!song) song = { source: parsed.source, songmid: parsed.songmid };
  let lastError = null;
  for (const attempt of qualityAttempts(quality)) {
    try {
      const data = await api("/api/music/url", {
        method: "POST",
        body: { songInfo: song, quality: attempt.quality, enableAutoSwitchApiSource: true },
      });
      const rawUrl = String(data?.url ?? "").trim();
      if (!rawUrl) throw fail("unavailable", tr("The server didn't return an audio address."));
      const type = audioType(rawUrl, attempt.quality);
      if (!type) throw fail("unavailable", tr("MyGo Music can't play this audio format. Try another quality."));
      const level = type === "flac" ? "lossless" : attempt.level === "lossless" ? "high" : attempt.level;
      const url = streamUrl(rawUrl, type, song, data);
      const cookie = cookieHeader();
      return {
        url,
        type,
        quality: level,
        headers: cookie && url.startsWith(`${serverBase()}/`) ? { Cookie: cookie } : undefined,
      };
    } catch (error) {
      if (error && (error.code === "signIn" || error.code === "setup")) throw error;
      lastError = error;
    }
  }
  throw lastError || fail("unavailable", tr("The server didn't return a playable address."));
}
