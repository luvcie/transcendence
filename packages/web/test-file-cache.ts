export function fakeFileCache(fail?: "open" | "put") {
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const caches = new Map<string, Map<string, Response>>();
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    async open(name: string) {
      if (fail === "open") throw new Error("Storage blocked");
      const entries = caches.get(name) ?? new Map<string, Response>();
      caches.set(name, entries);
      return {
        match: async (request: Request | string) => entries.get(typeof request === "string" ? request : request.url)?.clone(),
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        delete: async (request: Request | string) => entries.delete(typeof request === "string" ? request : request.url),
        put: async (url: string, response: Response) => {
          if (fail === "put") throw new Error("Quota exceeded");
          entries.set(url, response);
        },
      };
    },
  } });
  return {
    has: (url: string) => [...caches.values()].some(entries => entries.has(url)),
    restore() {
      if (original) Object.defineProperty(globalThis, "caches", original);
      else Reflect.deleteProperty(globalThis, "caches");
    },
  };
}
