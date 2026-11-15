import { expect, it } from "vitest";

import { cookieStorage } from "./cookies";

it("round-trips chunked Unicode sessions and clears all chunks on logout", () => {
  const jar: Record<string, string> = {};
  const storage = cookieStorage(
    () => jar,
    (key, value, maxAge) => {
      if (maxAge === 0) delete jar[key];
      else jar[key] = value;
    },
  );
  const value = JSON.stringify({ name: "日本語".repeat(3000) });
  storage.setItem("session", value);
  expect(Object.keys(jar).length).toBeGreaterThan(1);
  expect(storage.getItem("session")).toBe(value);
  storage.removeItem("session");
  expect(storage.getItem("session")).toBeNull();
  expect(jar).toEqual({});
});
