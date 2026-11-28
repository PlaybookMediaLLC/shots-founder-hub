import { afterEach, expect, it, vi } from "vitest";

import { uploadPrivateAttachment, STORAGE_CONFIG } from "./storage";

const options = {
  objectKey:
    "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.anb1",
  signedUploadToken: "a".repeat(64),
  ciphertextSha256: "b".repeat(64),
  ciphertextSizeBytes: STORAGE_CONFIG.chunkSize + 3,
  cloudUrl: "https://api.example.test/cloud",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("resumes multipart uploads without rereading accepted parts and confirms completion", async () => {
  let completed = false;
  let bytes: ArrayBuffer | undefined;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    if (input.endsWith("/status"))
      return Response.json({
        status: "active",
        size: options.ciphertextSizeBytes,
        chunkSize: STORAGE_CONFIG.chunkSize,
        parts: [{ number: 1, size: STORAGE_CONFIG.chunkSize }],
      });
    if (input.endsWith("/uploads/part")) {
      expect(JSON.parse(init.body as string)).toEqual({ number: 2 });
      return Response.json({
        url: "https://objects.example.test/part",
        size: 3,
      });
    }
    if (input.endsWith("/complete")) {
      completed = true;
      return new Response(null, { status: 204 });
    }
    bytes = await (init.body as Blob).arrayBuffer();
    return new Response(null, { status: 200 });
  });
  const upload = uploadPrivateAttachment({
    ...options,
    readRange: async (start, end) => {
      expect([start, end]).toEqual([
        STORAGE_CONFIG.chunkSize,
        options.ciphertextSizeBytes,
      ]);
      return new Uint8Array([1, 2, 3]);
    },
  });
  expect(await upload.promise).toBe(options.objectKey);
  expect(new Uint8Array(bytes!)).toEqual(new Uint8Array([1, 2, 3]));
  expect(completed).toBe(true);
});

it("cancels promptly during a stalled native read and revokes the upload capability", async () => {
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let revoked = false;
  vi.stubGlobal("fetch", async (input: string) => {
    if (input.endsWith("/abort")) {
      revoked = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      status: "active",
      size: options.ciphertextSizeBytes,
      chunkSize: STORAGE_CONFIG.chunkSize,
      parts: [],
    });
  });
  const upload = uploadPrivateAttachment({
    ...options,
    readRange: () => {
      reading();
      return new Promise(() => {});
    },
  });
  const rejection = expect(upload.promise).rejects.toMatchObject({
    name: "AbortError",
  });
  await started;
  await upload.abort();
  await rejection;
  expect(revoked).toBe(true);
});

it("rejects inconsistent resume metadata before reading or completing the file", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      status: "active",
      size: 1,
      chunkSize: STORAGE_CONFIG.chunkSize,
      parts: [],
    }),
  );
  const upload = uploadPrivateAttachment({
    ...options,
    readRange: async () => {
      throw new Error("must not read");
    },
  });
  await expect(upload.promise).rejects.toThrow("Invalid upload session");
});
