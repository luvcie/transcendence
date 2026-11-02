/** Canonical JSON preserves array order and sorts object keys by UTF-16 code units. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new RangeError("JSON nesting limit exceeded");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new RangeError("Non-finite JSON number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new RangeError("Invalid JSON value");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const entries: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new RangeError("Sparse JSON array");
        entries.push(encode(item[i], depth + 1));
      }
      result = `[${entries.join(",")}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new RangeError("Invalid JSON object");
      const obj = item as Record<string, unknown>;
      result = `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${encode(obj[key], depth + 1)}`).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value, 0);
}

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
