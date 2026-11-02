import { describe, expect, test } from "bun:test";
import { BUILTIN_SKINS, CLASSIC, type SkinDef } from "./src/skin-catalog";
import type { LoadedSkin } from "./src/skin-loader";
import { MultiplayerSkinPreference, MultiplayerSkinResolver, MULTIPLAYER_SKIN_RETRY_MS,
  MULTIPLAYER_SKIN_STORAGE_KEY, parseMultiplayerSkinMode, playerSkinAssignments, shareableSkinId,
  skinDefForId } from "./src/multiplayer-skins";

function def(id: string): SkinDef { return BUILTIN_SKINS.find(skin => skin.id === id)!; }
function loaded(id: string): LoadedSkin {
  return { def: def(id), image: { id } as unknown as HTMLImageElement, tile: 30 };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("skin identity", () => {
  test("shares built-in ids only and falls back to Classic for unknown values", () => {
    expect(shareableSkinId("four")).toBe("four");
    for (const active of ["custom:0", "", "unknown", "../four", "https://example.com/a.png"]) {
      expect(shareableSkinId(active)).toBe(CLASSIC.id);
    }
    expect(skinDefForId("four")).toBe(def("four"));
    for (const id of [undefined, null, "unknown", "custom:0", "__proto__"]) {
      expect(skinDefForId(id)).toBe(CLASSIC);
    }
  });

  test("multiplayer display preference defaults to per-player and persists locally", () => {
    expect(parseMultiplayerSkinMode(null)).toBe("player");
    expect(parseMultiplayerSkinMode("player")).toBe("player");
    expect(parseMultiplayerSkinMode("local")).toBe("local");
    expect(parseMultiplayerSkinMode("other")).toBe("player");
    const store = storage();
    expect(new MultiplayerSkinPreference(() => store).mode).toBe("player");
    const preference = new MultiplayerSkinPreference(() => store);
    preference.set("local");
    expect(store.values.get(MULTIPLAYER_SKIN_STORAGE_KEY)).toBe("local");
    expect(new MultiplayerSkinPreference(() => store).mode).toBe("local");
    store.values.set(MULTIPLAYER_SKIN_STORAGE_KEY, "bogus");
    expect(new MultiplayerSkinPreference(() => store).mode).toBe("player");
    const blocked = new MultiplayerSkinPreference(() => ({
      getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }));
    expect(blocked.mode).toBe("player");
    blocked.set("local");
    expect(blocked.mode).toBe("local");
  });
});

describe("player assignments", () => {
  test("two players see the same owner skin for each board by default", () => {
    const aSkin = loaded("four"), bSkin = loaded("tetrio");
    const library = new Map([["four", aSkin], ["tetrio", bSkin]]);
    const resolve = (id: string | undefined) => id ? library.get(id) : undefined;
    const players = [{ playerId: "a", skin: "four" }, { playerId: "b", skin: "tetrio" }];
    const roster = ["a", "b"];
    const fromA = playerSkinAssignments(roster, players, "a", aSkin, "player", resolve);
    const fromB = playerSkinAssignments(roster, players, "b", bSkin, "player", resolve);
    for (const assignments of [fromA, fromB]) {
      expect(assignments.size).toBe(2);
      expect(assignments.get("a")).toBe(aSkin);
      expect(assignments.get("b")).toBe(bSkin);
    }
  });

  test("eight players keep distinct skins keyed by stable player id", () => {
    const ids = ["four", "tetrio", "ppt", "effect", "t99", "apotris", "emoji", "nes"];
    const library = new Map(ids.map(id => [id, loaded(id)]));
    const resolve = (id: string | undefined) => id ? library.get(id) : undefined;
    const roster = ids.map((_, index) => `player-${index}`);
    const players = roster.map((playerId, index) => ({ playerId, skin: ids[index] }));
    const assignments = playerSkinAssignments(roster, players, "player-0", library.get("four"), "player", resolve);
    expect(assignments.size).toBe(8);
    roster.forEach((id, index) => expect(assignments.get(id)).toBe(library.get(ids[index])));
  });

  test("the local override applies the viewer's skin to every board", () => {
    const aSkin = loaded("four"), bSkin = loaded("tetrio");
    const library = new Map([["four", aSkin], ["tetrio", bSkin]]);
    const resolve = (id: string | undefined) => id ? library.get(id) : undefined;
    const players = [{ playerId: "a", skin: "four" }, { playerId: "b", skin: "tetrio" }];
    const roster = ["a", "b"];
    for (const [viewerId, viewerSkin] of [["a", aSkin], ["b", bSkin]] as const) {
      const perPlayer = playerSkinAssignments(roster, players, viewerId, viewerSkin, "player", resolve);
      const overridden = playerSkinAssignments(roster, players, viewerId, viewerSkin, "local", resolve);
      expect(overridden.size).toBe(2);
      expect([...overridden.values()].every(skin => skin === viewerSkin)).toBe(true);
      expect(perPlayer.get("a")).toBe(aSkin);
      expect(perPlayer.get("b")).toBe(bSkin);
    }
  });

  test("missing, unsupported and custom ids fall back without leaking another player's skin", () => {
    const custom = loaded("four"), bSkin = loaded("tetrio");
    const library = new Map([["tetrio", bSkin]]);
    const resolve = (id: string | undefined) => id ? library.get(id) : undefined;
    const players = [{ playerId: "a", skin: "classic" }, { playerId: "b", skin: "tetrio" },
      { playerId: "c", skin: "unknown" }, { playerId: "d" }];
    const fromA = playerSkinAssignments(["a", "b", "c", "d"], players, "a", custom, "player", resolve);
    expect(fromA.get("a")).toBe(custom);
    expect(fromA.get("b")).toBe(bSkin);
    for (const id of ["c", "d"]) expect(fromA.get(id)).toBeUndefined();
    const fromB = playerSkinAssignments(["a", "b", "c", "d"], players, "b", bSkin, "player", resolve);
    expect(fromB.get("a")).toBeUndefined();
    expect(fromB.get("b")).toBe(bSkin);
    expect(fromB.get("c")).toBeUndefined();
    expect(fromB.get("d")).toBeUndefined();
  });

  test("departures and replacements never retain a previous skin", () => {
    const aSkin = loaded("four"), cSkin = loaded("ppt");
    const library = new Map([["four", aSkin], ["ppt", cSkin]]);
    const resolve = (id: string | undefined) => id ? library.get(id) : undefined;
    const replacements = [{ playerId: "a", skin: "four" }, { playerId: "c", skin: "ppt" }];
    const assignments = playerSkinAssignments(["a", "c"], replacements, "a", aSkin, "player", resolve);
    expect(assignments.size).toBe(2);
    expect(assignments.has("b")).toBe(false);
    expect(assignments.get("a")).toBe(aSkin);
    expect(assignments.get("c")).toBe(cSkin);
  });
});

describe("remote skin loader", () => {
  test("loads each remote id once and only then asks for a redraw", async () => {
    const requests: string[] = [];
    const pending = new Map<string, ReturnType<typeof deferred<LoadedSkin | undefined>>>();
    let notifications = 0;
    const resolver = new MultiplayerSkinResolver(skin => {
      requests.push(skin.id);
      const request = deferred<LoadedSkin | undefined>();
      pending.set(skin.id, request);
      return request.promise;
    }, () => { notifications++; }, () => 0);
    expect(resolver.get("four")).toBeUndefined();
    expect(resolver.get("four")).toBeUndefined();
    expect(requests).toEqual(["four"]);
    pending.get("four")!.resolve(loaded("four"));
    await Bun.sleep(0);
    expect(resolver.get("four")!.def.id).toBe("four");
    expect(notifications).toBe(1);
    expect(resolver.get("four")).toBe(resolver.get("four"));
    expect(requests).toEqual(["four"]);
    expect(resolver.get("classic")).toBeUndefined();
    expect(resolver.get(undefined)).toBeUndefined();
    expect(resolver.get("custom:0")).toBeUndefined();
    expect(resolver.get("unknown")).toBeUndefined();
    expect(requests).toEqual(["four"]);
  });

  test("failed remote skins fall back to Classic and retry only after the cooldown", async () => {
    let now = 0, attempts = 0, notifications = 0;
    let result: LoadedSkin | undefined;
    const resolver = new MultiplayerSkinResolver(async () => {
      attempts++;
      if (!result) throw new Error("offline");
      return result;
    }, () => { notifications++; }, () => now);
    expect(resolver.get("tetrio")).toBeUndefined();
    await Bun.sleep(0);
    expect(attempts).toBe(1);
    expect(resolver.get("tetrio")).toBeUndefined();
    expect(attempts).toBe(1);
    now = MULTIPLAYER_SKIN_RETRY_MS - 1;
    expect(resolver.get("tetrio")).toBeUndefined();
    expect(attempts).toBe(1);
    now = MULTIPLAYER_SKIN_RETRY_MS;
    expect(resolver.get("tetrio")).toBeUndefined();
    expect(attempts).toBe(2);
    await Bun.sleep(0);
    result = loaded("tetrio");
    now = MULTIPLAYER_SKIN_RETRY_MS * 2;
    expect(resolver.get("tetrio")).toBeUndefined();
    expect(attempts).toBe(3);
    await Bun.sleep(0);
    expect(resolver.get("tetrio")!.def.id).toBe("tetrio");
    expect(notifications).toBe(1);
  });
});
