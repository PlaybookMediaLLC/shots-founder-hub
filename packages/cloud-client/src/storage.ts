export const STORAGE_CONFIG = {
  bucketName: "audio-files",
  chunkSize: 6 * 1024 * 1024,
  retryDelays: [0, 3000, 5000, 10000, 20000],
} as const;

export const PRIVATE_ATTACHMENT_STORAGE_CONFIG = {
  bucketName: "attachment-backups",
  contentType: "application/octet-stream",
  chunkSize: 6 * 1024 * 1024,
  maxCiphertextSizeBytes: 520 * 1024 * 1024,
  retryDelays: [0, 3000, 5000, 10000, 20000],
} as const;

export const SHARED_ATTACHMENT_STORAGE_CONFIG = {
  bucketName: "shared-note-attachments",
  chunkSize: 6 * 1024 * 1024,
  maxSizeBytes: 512 * 1024 * 1024,
  retryDelays: [0, 3000, 5000, 10000, 20000],
} as const;

const PRIVATE_ATTACHMENT_OBJECT_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.anb1$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SHARED_ATTACHMENT_OBJECT_KEY_PATTERN = new RegExp(
  `^${UUID_V4_PATTERN}/${UUID_V4_PATTERN}/${UUID_V4_PATTERN}\\.sna1$`,
);

function uploadEndpoint(cloudUrl: string) {
  const url = new URL(cloudUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Invalid upload API URL");
  url.pathname =
    url.pathname.replace(/\/cloud\/?$/, "").replace(/\/$/, "") + "/sync/files";
  return url.toString().replace(/\/$/, "");
}

function abortError() {
  const error = new Error("Upload cancelled");
  error.name = "AbortError";
  return error;
}

async function responseJson(response: Response): Promise<any> {
  if (!response.ok)
    throw Object.assign(new Error("Upload request failed"), {
      status: response.status,
    });
  return response.status === 204 ? null : response.json();
}

function multipart(options: {
  objectKey: string;
  size: number;
  cloudUrl: string;
  grant: (signal: AbortSignal) => Promise<string>;
  readRange: (start: number, end: number) => Promise<Uint8Array>;
  onProgress?: (percentage: number) => void;
}) {
  const controller = new AbortController();
  const endpoint = uploadEndpoint(options.cloudUrl);
  let token: string | undefined;
  let settled = false;
  let cancellation: Promise<void> | undefined;
  const check = () => {
    if (controller.signal.aborted) throw abortError();
  };
  const request = async (
    path: string,
    body?: unknown,
    signal = controller.signal,
  ) =>
    responseJson(
      await fetch(`${endpoint}/uploads/${path}`, {
        method: "POST",
        headers: {
          "x-upload-token": token!,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
    );
  const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        return await operation();
      } catch (error) {
        check();
        const status = (error as { status?: number }).status;
        if (
          attempt >= 4 ||
          (status !== undefined &&
            status < 500 &&
            status !== 429 &&
            status !== 408)
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => {
            clearTimeout(timer);
            reject(abortError());
          };
          const timer = setTimeout(
            () => {
              controller.signal.removeEventListener("abort", cancelled);
              resolve();
            },
            STORAGE_CONFIG.retryDelays[attempt + 1],
          );
          controller.signal.addEventListener("abort", cancelled, {
            once: true,
          });
        });
      }
    }
  };
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const cancelRemote = async () => {
    if (!token) return;
    const cleanup = new AbortController();
    const timeout = setTimeout(() => cleanup.abort(), 10000);
    try {
      await request("abort", undefined, cleanup.signal);
    } finally {
      clearTimeout(timeout);
    }
  };
  const work = (async () => {
    token = await options.grant(controller.signal);
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid upload capability");
    if (controller.signal.aborted) {
      await cancelRemote();
      throw abortError();
    }
    const status = await retry(() => request("status"));
    if (
      status?.size !== options.size ||
      status?.chunkSize !== STORAGE_CONFIG.chunkSize ||
      !["active", "complete"].includes(status?.status) ||
      !Array.isArray(status.parts)
    )
      throw new Error("Invalid upload session");
    if (status.status === "complete") {
      options.onProgress?.(100);
      return options.objectKey;
    }
    const count = Math.ceil(options.size / STORAGE_CONFIG.chunkSize);
    const completed = new Set<number>();
    let uploaded = 0;
    for (const part of status.parts) {
      const size = Math.min(
        STORAGE_CONFIG.chunkSize,
        options.size - (part.number - 1) * STORAGE_CONFIG.chunkSize,
      );
      if (
        !Number.isInteger(part.number) ||
        part.number < 1 ||
        part.number > count ||
        part.size !== size ||
        completed.has(part.number)
      )
        throw new Error("Invalid uploaded part");
      completed.add(part.number);
      uploaded += size;
    }
    options.onProgress?.((uploaded / options.size) * 100);
    for (let number = 1; number <= count; number++) {
      check();
      if (completed.has(number)) continue;
      const start = (number - 1) * STORAGE_CONFIG.chunkSize;
      const end = Math.min(start + STORAGE_CONFIG.chunkSize, options.size);
      const bytes = await options.readRange(start, end);
      check();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== end - start)
        throw new Error("File read was incomplete");
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      await retry(async () => {
        const part = await request("part", { number });
        const url = new URL(part.url);
        if (
          part.size !== bytes.byteLength ||
          url.username ||
          url.password ||
          url.hash ||
          (url.protocol !== "https:" &&
            !(
              url.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
              new URL(endpoint).protocol === "http:"
            ))
        )
          throw new Error("Invalid part URL");
        const response = await fetch(url.toString(), {
          method: "PUT",
          body: new Blob([owned.buffer]),
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok)
          throw Object.assign(new Error("Could not upload file part"), {
            status: response.status,
          });
      });
      uploaded += bytes.byteLength;
      options.onProgress?.((uploaded / options.size) * 100);
    }
    check();
    await retry(() => request("complete"));
    return options.objectKey;
  })();
  const promise = Promise.race([work, cancelled]).finally(() => {
    settled = true;
  });
  return {
    promise,
    abort: () => {
      if (cancellation) return cancellation;
      if (settled) return Promise.resolve();
      controller.abort();
      rejectCancelled(abortError());
      cancellation = cancelRemote();
      return cancellation;
    },
  };
}

export function buildObjectName(userId: string, fileName: string): string {
  return `${userId}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200)}`;
}

export function uploadAudio(options: {
  file: File | Blob;
  fileName: string;
  contentType: string;
  cloudUrl: string;
  accessToken: string;
  userId: string;
  onProgress?: (percentage: number) => void;
}) {
  const objectKey = buildObjectName(options.userId, options.fileName);
  if (
    !options.file.size ||
    options.file.size > PRIVATE_ATTACHMENT_STORAGE_CONFIG.maxCiphertextSizeBytes
  )
    throw new Error("Invalid audio file size");
  return multipart({
    objectKey,
    size: options.file.size,
    cloudUrl: options.cloudUrl,
    onProgress: options.onProgress,
    readRange: async (start, end) =>
      new Uint8Array(await options.file.slice(start, end).arrayBuffer()),
    grant: async (signal) => {
      const grant = await responseJson(
        await fetch(`${uploadEndpoint(options.cloudUrl)}/begin`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            bucket: STORAGE_CONFIG.bucketName,
            key: objectKey,
            contentType: options.contentType,
            size: options.file.size,
          }),
          signal,
        }),
      );
      return grant.token;
    },
  });
}

function validateGrant(token: string, size: number, max: number) {
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("Invalid upload capability");
  if (!Number.isSafeInteger(size) || size <= 0 || size > max)
    throw new Error("Invalid upload size");
}

export function uploadPrivateAttachment(options: {
  objectKey: string;
  signedUploadToken: string;
  ciphertextSha256: string;
  ciphertextSizeBytes: number;
  cloudUrl: string;
  readRange: (start: number, end: number) => Promise<Uint8Array>;
  onProgress?: (percentage: number) => void;
}) {
  if (!PRIVATE_ATTACHMENT_OBJECT_KEY_PATTERN.test(options.objectKey))
    throw new Error("Invalid private attachment object key");
  if (!SHA256_PATTERN.test(options.ciphertextSha256))
    throw new Error("Invalid private attachment checksum");
  validateGrant(
    options.signedUploadToken,
    options.ciphertextSizeBytes,
    PRIVATE_ATTACHMENT_STORAGE_CONFIG.maxCiphertextSizeBytes,
  );
  return multipart({
    ...options,
    size: options.ciphertextSizeBytes,
    grant: async () => options.signedUploadToken,
  });
}

export function uploadSharedAttachment(options: {
  objectKey: string;
  signedUploadToken: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  cloudUrl: string;
  readRange: (start: number, end: number) => Promise<Uint8Array>;
  onProgress?: (percentage: number) => void;
}) {
  if (!SHARED_ATTACHMENT_OBJECT_KEY_PATTERN.test(options.objectKey))
    throw new Error("Invalid shared attachment object key");
  if (!SHA256_PATTERN.test(options.sha256))
    throw new Error("Invalid shared attachment checksum");
  if (!isSafeSharedContentType(options.contentType))
    throw new Error("Invalid shared attachment content type");
  validateGrant(
    options.signedUploadToken,
    options.sizeBytes,
    SHARED_ATTACHMENT_STORAGE_CONFIG.maxSizeBytes,
  );
  return multipart({
    ...options,
    size: options.sizeBytes,
    grant: async () => options.signedUploadToken,
  });
}

function isSafeSharedContentType(value: string) {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value !== value.toLowerCase().trim() ||
    [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
      "application/javascript",
      "text/javascript",
    ].includes(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => part.length > 0 && /^[a-z0-9!#$&^_.+-]+$/.test(part))
  );
}
