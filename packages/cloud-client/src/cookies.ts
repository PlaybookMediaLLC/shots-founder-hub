import type { SupportedStorage } from "./client";

const PREFIX = "founder-hub-session";
const CHUNK_SIZE = 3000;
const MAX_CHUNKS = 16;

export function cookieStorage(
  read: () => Record<string, string>,
  write: (name: string, value: string, maxAge: number) => void,
): SupportedStorage {
  const clear = () => {
    for (const name of Object.keys(read()))
      if (name === PREFIX || name.startsWith(`${PREFIX}.`)) write(name, "", 0);
  };
  return {
    getItem: () => {
      const cookies = read();
      const count = Number(cookies[PREFIX]);
      if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS)
        return null;
      let value = "";
      for (let index = 0; index < count; index++) {
        const chunk = cookies[`${PREFIX}.${index}`];
        if (!chunk || chunk.length > CHUNK_SIZE) return null;
        value += chunk;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
        );
      } catch {
        return null;
      }
    },
    setItem: (_key, value) => {
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > CHUNK_SIZE * MAX_CHUNKS * 0.75)
        throw new Error("Session is too large");
      const encoded = btoa(String.fromCharCode(...bytes));
      const count = Math.ceil(encoded.length / CHUNK_SIZE);
      clear();
      for (let index = 0; index < count; index++)
        write(
          `${PREFIX}.${index}`,
          encoded.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
          30 * 24 * 3600,
        );
      write(PREFIX, String(count), 30 * 24 * 3600);
    },
    removeItem: clear,
  };
}
