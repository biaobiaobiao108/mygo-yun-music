import { beforeEach, describe, expect, test } from "bun:test";

function makeHost(settings = {}, initial = {}) {
  const data = initial && Object.keys(initial).length ? JSON.parse(JSON.stringify(initial)) : {};
  const values = { ...settings };
  return {
    setting: key => values[key] ?? "",
    t: text => text,
    storage: {
      get: key => data[key],
      set: (key, value) => {
        data[key] = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      },
      remove: key => {
        delete data[key];
      },
    },
    __data: data,
    __settings: values,
  };
}

function response(body, status = 200, cookies = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => cookies,
      get: name => (String(name).toLowerCase() === "set-cookie" ? cookies.join(", ") : null),
    },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

function plain(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => [], get: () => null },
    text: async () => text,
  };
}

const song = {
  id: 186016,
  songmid: 186016,
  name: "晴天",
  singer: "周杰伦",
  albumName: "叶惠美",
  albumId: 18875,
  source: "wy",
  interval: "04:29",
  img: "https://p1.music.126.net/cover.jpg",
  types: [{ type: "128k", size: "3.5M" }],
};

const loveSong = {
  id: "186016",
  songmid: 186016,
  name: "晴天",
  singer: "周杰伦",
  albumName: "叶惠美",
  source: "wy",
  interval: "04:29",
  img: "https://p1.music.126.net/cover.jpg",
};

let routes = [];
let calls = [];

function route(method, path, handler) {
  routes.push({ method: method.toUpperCase(), path, handler });
}

function dispatch(url, init = {}) {
  const parsed = new URL(url);
  const method = String(init.method || "GET").toUpperCase();
  calls.push({ method, path: parsed.pathname, query: parsed.searchParams, headers: init.headers || {}, body: init.body });
  const found = routes.find(item => item.method === method && item.path === parsed.pathname);
  if (!found) return Promise.resolve(response({ message: `unexpected ${method} ${parsed.pathname}` }, 500));
  return Promise.resolve(found.handler(parsed, init));
}

function configOff() {
  route("GET", "/api/music/config", () => response({ "player.enableAuth": false }));
}

function accountRoutes(listData) {
  configOff();
  route("POST", "/api/user/login", () =>
    response({ success: true, username: "tester" }, 200, ["lx_user_session=user123; Path=/; HttpOnly"]),
  );
  route("GET", "/api/user/auth/verify", () => response({ valid: true, username: "tester" }));
  route("GET", "/api/user/list", () => response(listData));
}

globalThis.host = makeHost();
const plugin = await import("../index.js");

beforeEach(async () => {
  routes = [];
  calls = [];
  globalThis.host = makeHost({ server: "http://music.local:9527", source: "wy" });
  await plugin.setSetting({ key: "server" });
  globalThis.fetch = async (url, init = {}) => dispatch(String(url), init);
});

describe("mapping", () => {
  test("search maps tracks", async () => {
    configOff();
    route("GET", "/api/music/search", parsed => {
      expect(parsed.searchParams.get("type")).toBe("song");
      expect(parsed.searchParams.get("limit")).toBe("30");
      return response([song]);
    });
    const result = await plugin.search({ query: "晴天", kind: "tracks", offset: 0 });
    expect(result.tracks.length).toBe(1);
    expect(result.tracks[0].id).toBe("t:wy:186016");
    expect(result.tracks[0].name).toBe("晴天");
    expect(result.tracks[0].duration).toBe(269000);
    expect(result.tracks[0].artists[0].name).toBe("周杰伦");
    expect(result.tracks[0].album.id).toBe("al:wy:18875");
    expect(result.tracks[0].url).toContain("music.163.com");
    expect(result.more).toBe(false);
  });

  test("search maps albums, artists and playlists", async () => {
    configOff();
    route("GET", "/api/music/search", parsed => {
      const type = parsed.searchParams.get("type");
      if (type === "album") {
        return response([
          {
            id: 18875,
            name: "叶惠美",
            picUrl: "https://p1.music.126.net/album.jpg",
            artistName: "周杰伦",
            artistId: 6452,
            publishTime: 1057017600000,
          },
        ]);
      }
      if (type === "singer") return response([{ id: 6452, name: "周杰伦", picUrl: "https://p1.music.126.net/a.jpg" }]);
      return response([]);
    });
    route("GET", "/api/music/songList/search", parsed => {
      expect(parsed.searchParams.get("text")).toBe("x");
      return response({
        list: [{ id: 123, name: "歌单", img: "https://p1.music.126.net/p.jpg", author: "某人", total: 5 }],
        total: 5,
      });
    });

    const albums = await plugin.search({ query: "x", kind: "albums", offset: 0 });
    expect(albums.albums[0].id).toBe("al:wy:18875");
    expect(albums.albums[0].artists[0].id).toBe("ar:wy:6452");
    expect(albums.albums[0].released).toBe("2003-07-01");

    const artists = await plugin.search({ query: "x", kind: "artists", offset: 0 });
    expect(artists.artists[0].id).toBe("ar:wy:6452");
    expect(artists.artists[0].name).toBe("周杰伦");

    const playlists = await plugin.search({ query: "x", kind: "playlists", offset: 0 });
    expect(playlists.playlists[0].id).toBe("p:wy:123");
    expect(playlists.playlists[0].owner).toBe("某人");
    expect(playlists.playlists[0].trackCount).toBe(5);
  });

  test("album, artist and playlist pages map", async () => {
    configOff();
    route("GET", "/api/music/albumSongs", () => response({ list: [song], name: "叶惠美", publishTime: 1057017600000 }));
    const album = await plugin.album({ id: "al:wy:18875" });
    expect(album.album.name).toBe("叶惠美");
    expect(album.album.released).toBe("2003-07-01");
    expect(album.tracks[0].id).toBe("t:wy:186016");

    route("GET", "/api/music/artistDetail", () => response({ id: 6452, name: "周杰伦", avatar: "https://p1.music.126.net/a.jpg" }));
    route("GET", "/api/music/artistSongs", parsed =>
      response({ list: parsed.searchParams.get("page") === "1" ? [song] : [], total: 1 }),
    );
    route("GET", "/api/music/artistAlbums", () =>
      response({ list: [{ id: 18875, name: "叶惠美", img: "https://p1.music.126.net/album.jpg", singer: "周杰伦" }] }),
    );
    const artist = await plugin.artist({ id: "ar:wy:6452" });
    expect(artist.artist.name).toBe("周杰伦");
    expect(artist.tracks[0].id).toBe("t:wy:186016");
    expect(artist.albums[0].id).toBe("al:wy:18875");

    route("GET", "/api/music/songList/detail", () =>
      response({ list: [song], total: 1, info: { name: "歌单", img: "https://p1.music.126.net/p.jpg", author: "某人", desc: "简介" } }),
    );
    const playlist = await plugin.playlist({ id: "p:wy:123" });
    expect(playlist.name).toBe("歌单");
    expect(playlist.owner).toBe("某人");
    expect(playlist.tracks[0].id).toBe("t:wy:186016");
  });

  test("lyrics map", async () => {
    configOff();
    route("GET", "/api/music/lyric", () => response({ lyric: "[00:01.00]line", tlyric: "[00:01.00]翻译" }));
    const result = await plugin.lyrics({ id: "t:wy:1" });
    expect(result.lrc).toContain("line");
    expect(result.translation).toContain("翻译");
  });
});

describe("playback", () => {
  test("stream uses the relay and direct cache urls", async () => {
    configOff();
    let mode = "relay";
    route("POST", "/api/music/url", () =>
      mode === "relay"
        ? response({ url: "https://cdn.example.com/a.flac", downloadToken: "tok", type: "flac" })
        : response({ url: "/api/music/cache/file/_open/a.flac?folder=cache", downloadToken: "tok" }),
    );
    const relayed = await plugin.stream({ id: "t:wy:1", quality: "lossless" });
    expect(relayed.type).toBe("flac");
    expect(relayed.quality).toBe("lossless");
    expect(relayed.url).toBe(
      "http://music.local:9527/api/music/download?url=https%3A%2F%2Fcdn.example.com%2Fa.flac&token=tok&inline=1&filename=audio.flac",
    );
    mode = "cache";
    const cached = await plugin.stream({ id: "t:wy:1", quality: "lossless" });
    expect(cached.url).toBe("http://music.local:9527/api/music/cache/file/_open/a.flac?folder=cache");
  });

  test("stream falls back a quality", async () => {
    configOff();
    route("POST", "/api/music/url", (_parsed, init) => {
      const body = JSON.parse(init.body);
      if (body.quality === "flac") return response({ message: "no flac" }, 422);
      return response({ url: "https://cdn.example.com/a.mp3", downloadToken: "tok" });
    });
    const result = await plugin.stream({ id: "t:wy:1", quality: "lossless" });
    expect(result.type).toBe("mp3");
    expect(result.quality).toBe("high");
  });
});

describe("authentication", () => {
  test("player password is stored and sent", async () => {
    globalThis.host = makeHost({ server: "http://music.local:9527", source: "wy", playerPassword: "pw" });
    await plugin.setSetting({ key: "server" });
    route("GET", "/api/music/config", () => response({ "player.enableAuth": true }));
    route("POST", "/api/music/auth", () =>
      response({ success: true }, 200, ["lx_player_session=player123; Path=/; HttpOnly"]),
    );
    let cookie = "";
    route("GET", "/api/music/search", (_parsed, init) => {
      cookie = init.headers.Cookie || "";
      return response([song]);
    });
    await plugin.search({ query: "x", kind: "tracks", offset: 0 });
    expect(cookie).toContain("lx_player_session=player123");
  });

  test("missing player password asks for setup", async () => {
    route("GET", "/api/music/config", () => response({ "player.enableAuth": true }));
    let error;
    try {
      await plugin.search({ query: "x", kind: "tracks", offset: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("setup");
  });

  test("account login, playlists, likes and removal", async () => {
    globalThis.host = makeHost({
      server: "http://music.local:9527",
      source: "wy",
      username: "tester",
      password: "secret",
    });
    await plugin.setSetting({ key: "server" });
    accountRoutes({
      defaultList: [],
      loveList: [loveSong],
      userList: [{ id: "list_1", name: "我的歌单", list: [loveSong] }],
    });
    const otherSong = { ...song, id: 999, songmid: 999, name: "其他" };
    route("GET", "/api/music/search", () => response([otherSong]));
    let addBody = null;
    let removeBody = null;
    route("POST", "/api/music/user/list/add", (_parsed, init) => {
      addBody = JSON.parse(init.body);
      return plain("添加成功");
    });
    route("POST", "/api/music/user/list/remove", (_parsed, init) => {
      removeBody = JSON.parse(init.body);
      return plain("删除成功");
    });

    const lists = await plugin.playlists();
    expect(lists[0].id).toBe("u:list_1");
    expect(lists[0].name).toBe("我的歌单");
    expect(lists[0].mine).toBe(true);

    const account = await plugin.account();
    expect(account.imageUrl).toBe("http://music.local:9527/music/assets/yun-yin-favicon.png");

    const liked = await plugin.liked({ offset: 0 });
    expect(liked.tracks[0].id).toBe("t:wy:186016");
    const flags = await plugin.isLiked({ ids: ["t:wy:186016", "t:wy:2"] });
    expect(flags["t:wy:186016"]).toBe(true);
    expect(flags["t:wy:2"]).toBe(false);

    await plugin.search({ query: "其他", kind: "tracks", offset: 0 });
    await plugin.like({ id: "t:wy:999", on: true });
    expect(addBody.listId).toBe("love");
    expect(addBody.musicInfos[0].id).toBe(999);

    await plugin.like({ id: "t:wy:186016", on: false });
    expect(removeBody.listId).toBe("love");
    expect(removeBody.songIds).toEqual(["186016"]);
  });
});

describe("pages and writes", () => {
  test("home has charts and discover", async () => {
    configOff();
    route("GET", "/api/music/leaderboard/boards", () =>
      response({
        list: [
          { bangid: "1", name: "飙升榜", img: "https://p1.music.126.net/chart.jpg" },
          { bangid: "2", name: "新歌榜" },
        ],
      }),
    );
    route("GET", "/api/music/songList/list", () =>
      response({ list: [{ id: "9", name: "发现歌单", img: "https://p1.music.126.net/p.jpg", author: "某人", total: 3 }] }),
    );
    const page = await plugin.home();
    expect(page.sections.map(section => section.title)).toEqual(["Charts", "Discover"]);
    expect(page.sections[0].playlists[0].id).toBe("b:wy:1");
    expect(page.sections[0].playlists[0].imageUrl).toBe("https://p1.music.126.net/chart.jpg");
    expect(page.sections[0].playlists[1].imageUrl).toBe(
      "http://music.local:9527/music/assets/yun-yin-favicon.png",
    );
    expect(page.sections[1].playlists[0].id).toBe("p:wy:9");
  });

  test("saveAlbum writes the library", async () => {
    globalThis.host = makeHost({
      server: "http://music.local:9527",
      source: "wy",
      username: "tester",
      password: "secret",
    });
    await plugin.setSetting({ key: "server" });
    accountRoutes({ defaultList: [], loveList: [], userList: [] });
    route("GET", "/api/music/albumSongs", () => response({ list: [song], name: "叶惠美" }));
    route("GET", "/api/user/library/albums", () => response([]));
    let saved = null;
    route("POST", "/api/user/library/albums", (_parsed, init) => {
      saved = JSON.parse(init.body);
      return response({ success: true });
    });
    await plugin.saveAlbum({ id: "al:wy:18875", on: true });
    expect(Array.isArray(saved)).toBe(true);
    expect(saved[0].id).toBe("18875");
    expect(saved[0].name).toBe("叶惠美");
    expect(saved[0].source).toBe("wy");
  });

  test("savePlaylist toggles an online playlist", async () => {
    globalThis.host = makeHost({
      server: "http://music.local:9527",
      source: "wy",
      username: "tester",
      password: "secret",
    });
    await plugin.setSetting({ key: "server" });
    accountRoutes({ defaultList: [], loveList: [], userList: [] });
    route("GET", "/api/music/songList/detail", () =>
      response({ list: [song], total: 1, info: { name: "歌单", img: "https://p1.music.126.net/p.jpg" } }),
    );
    let mutation = null;
    route("POST", "/api/user/playlists", (_parsed, init) => {
      mutation = JSON.parse(init.body);
      return response({ success: true, added: true });
    });
    await plugin.savePlaylist({ id: "p:wy:123", on: true });
    expect(mutation.action).toBe("toggle");
    expect(mutation.playlist.source).toBe("wy");
    expect(mutation.playlist.sourceListId).toBe("123");
    expect(mutation.playlist.list.length).toBe(1);
  });

  test("user playlists list newest first and move in that order", async () => {
    globalThis.host = makeHost({
      server: "http://music.local:9527",
      source: "wy",
      username: "tester",
      password: "secret",
    });
    await plugin.setSetting({ key: "server" });
    const otherSong = { ...song, id: 999, songmid: 999, name: "其他" };
    accountRoutes({
      defaultList: [],
      loveList: [],
      userList: [
        { id: "list_1", name: "我的歌单", list: [song, otherSong] },
        { id: "list_2", name: "导入", source: "wy", sourceListId: "123", list: [song, otherSong] },
      ],
    });
    let saved = null;
    route("POST", "/api/user/list", (_parsed, init) => {
      saved = JSON.parse(init.body);
      return response({ success: true });
    });

    const own = await plugin.playlist({ id: "u:list_1" });
    expect(own.tracks.map(track => track.name)).toEqual(["其他", "晴天"]);
    const imported = await plugin.playlist({ id: "u:list_2" });
    expect(imported.tracks.map(track => track.name)).toEqual(["晴天", "其他"]);

    await plugin.movePlaylistTrack({ id: "u:list_1", from: 0, to: 1 });
    expect(saved.userList.find(list => list.id === "list_1").list.map(item => item.name)).toEqual(["其他", "晴天"]);
  });

  test("played writes a playback event and falls back for older servers", async () => {
    globalThis.host = makeHost({
      server: "http://music.local:9527",
      source: "wy",
      username: "tester",
      password: "secret",
    });
    await plugin.setSetting({ key: "server" });
    accountRoutes({ defaultList: [], loveList: [], userList: [] });
    route("GET", "/api/music/search", () => response([song]));
    let eventBody = null;
    route("POST", "/api/user/play-history/events", (_parsed, init) => {
      eventBody = JSON.parse(init.body);
      return response({ items: [] });
    });
    await plugin.search({ query: "晴天", kind: "tracks", offset: 0 });
    await plugin.played({ id: "t:wy:186016" });
    expect(eventBody.events[0].id).toMatch(/^\d+-[a-z0-9]+$/);
    expect(eventBody.events[0].song.songmid).toBe(186016);

    routes = routes.filter(item => item.path !== "/api/user/play-history/events");
    route("POST", "/api/user/play-history/events", () => response({ message: "not found" }, 404));
    let legacyBody = null;
    route("POST", "/api/user/play-history", (_parsed, init) => {
      legacyBody = JSON.parse(init.body);
      return response({ items: [] });
    });
    await plugin.played({ id: "t:wy:186016" });
    expect(legacyBody.items[0].songmid).toBe(186016);
  });

  test("changing the server forgets sessions and songs", async () => {
    configOff();
    route("GET", "/api/music/search", () => response([song]));
    await plugin.search({ query: "x", kind: "tracks", offset: 0 });
    expect(globalThis.host.__data.songs).toBeDefined();
    await plugin.setSetting({ key: "server" });
    expect(globalThis.host.__data.songs).toBeUndefined();
    expect(globalThis.host.__data.auth).toEqual({ playerCookie: "", userCookie: "", signedOut: false });
  });
});
