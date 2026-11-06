// Manual integration check against a running YunLu Music server.
// Set YUN_MUSIC_SERVER (and optionally account variables) before running:
//   bun run test/live.js
// Add YUN_MUSIC_WRITE=1 to exercise likes, playlists and play history.

const server = String(process.env.YUN_MUSIC_SERVER || "").trim();
if (!server) {
  console.log("Set YUN_MUSIC_SERVER, for example http://127.0.0.1:9527");
  process.exit(0);
}

const settings = {
  server,
  source: process.env.YUN_MUSIC_SOURCE || "wy",
  username: process.env.YUN_MUSIC_USERNAME || "",
  password: process.env.YUN_MUSIC_PASSWORD || "",
  playerPassword: process.env.YUN_MUSIC_PLAYER_PASSWORD || "",
};
const query = process.env.YUN_MUSIC_QUERY || "周杰伦";
const write = process.env.YUN_MUSIC_WRITE === "1";
const data = {};

globalThis.host = {
  setting: key => settings[key] ?? "",
  t: text => text,
  storage: {
    get: key => data[key],
    set: (key, value) => {
      data[key] = value;
    },
    remove: key => {
      delete data[key];
    },
  },
};

const plugin = await import("../index.js");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function log(...args) {
  console.log(...args);
}

let account = null;
if (settings.username && settings.password) {
  account = await plugin.account();
  check(account && account.name, "account login failed");
  log("account", account.name);
}

const found = await plugin.search({ query, kind: "tracks", offset: 0 });
check(found.tracks.length > 0, "track search returned nothing");
const track = found.tracks[0];
log("track", track.name, track.id);

const [albums, artists, playlists] = await Promise.all([
  plugin.search({ query, kind: "albums", offset: 0 }),
  plugin.search({ query, kind: "artists", offset: 0 }),
  plugin.search({ query, kind: "playlists", offset: 0 }),
]);
log("search", `albums ${albums.albums.length}`, `artists ${artists.artists.length}`, `playlists ${playlists.playlists.length}`);

const lyrics = await plugin.lyrics({ id: track.id });
check(typeof lyrics.lrc === "string", "lyrics did not return lrc");
log("lyrics", lyrics.lrc.length, "chars");

const stream = await plugin.stream({ id: track.id, quality: "high" });
check(stream.url && ["mp3", "flac", "ogg"].includes(stream.type), "stream returned an unsupported format");
const audio = await fetch(stream.url, { headers: stream.headers });
const bytes = new Uint8Array(await audio.arrayBuffer());
check(audio.ok && bytes.length > 0, `audio request failed: ${audio.status}`);
log("stream", stream.type, audio.status, bytes.length, "bytes");

if (track.album && track.album.id) {
  const page = await plugin.album({ id: track.album.id });
  check(page.tracks.length > 0, "album page returned no tracks");
  log("album", page.album.name, page.tracks.length);
}

if (track.artists && track.artists[0]) {
  const page = await plugin.artist({ id: track.artists[0].id });
  check(page.artist.name, "artist page returned no artist");
  log("artist", page.artist.name, page.tracks.length, page.albums.length);
}

if (playlists.playlists[0]) {
  const page = await plugin.playlist({ id: playlists.playlists[0].id });
  check(page.tracks.length > 0, "playlist page returned no tracks");
  log("playlist", page.name, page.tracks.length);
}

const comments = await plugin.comments({ trackId: track.id, offset: 0 });
log("comments", comments.comments.length, "of", comments.total);

const home = await plugin.home();
check(home.sections.length > 0, "home returned no sections");
log("home", home.sections.map(section => section.title).join(", "));
const withPlaylists = home.sections.find(section => section.playlists && section.playlists.length);
check(withPlaylists && withPlaylists.playlists[0].imageUrl, "home returned no playlist cover");
const cover = await fetch(withPlaylists.playlists[0].imageUrl);
check(cover.ok, `playlist cover failed: ${cover.status}`);
if (account) {
  const icon = await fetch(account.imageUrl);
  check(icon.ok, `account icon failed: ${icon.status}`);
}

if (write) {
  check(settings.username && settings.password, "YUN_MUSIC_WRITE needs an account");
  let created = null;
  let liked = false;
  try {
    await plugin.like({ id: track.id, on: true });
    liked = true;
    check((await plugin.isLiked({ ids: [track.id] }))[track.id], "like did not stick");

    created = await plugin.createPlaylist({ name: `MyGo live check ${Date.now()}` });
    await plugin.addToPlaylist({ id: created.id, trackIds: [track.id] });
    let page = await plugin.playlist({ id: created.id });
    check(page.tracks.some(item => item.id === track.id), "playlist add did not stick");
    await plugin.removeFromPlaylist({ id: created.id, trackIds: [track.id] });
    page = await plugin.playlist({ id: created.id });
    check(page.tracks.length === 0, "playlist remove did not stick");

    const second = found.tracks[1] || track;
    await plugin.played({ id: track.id });
    await plugin.played({ id: second.id });
    const recent = await plugin.recent();
    check(recent[0]?.id === second.id, "play history did not record the latest track");
    log("writes", "like, playlist, history");
  } finally {
    if (created) await plugin.deletePlaylist({ id: created.id }).catch(() => {});
    if (liked) await plugin.like({ id: track.id, on: false }).catch(() => {});
  }
}

log("live check passed");
