import { z } from "zod";

const encoded = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const privateActionKeySchema = encoded.length(88);
const envelopeSchema = z
  .object({
    publicKey: privateActionKeySchema,
    iv: encoded.length(16),
    ciphertext: encoded.min(24).max(200000),
  })
  .strict();
const responseSchema = envelopeSchema.omit({ publicKey: true });
export const autoFormatExamplesSchema = z
  .array(z.string().trim().min(1).max(12000))
  .min(1)
  .max(3);
export const autoFormatResultSchema = z.string().trim().min(1).max(16000);
export const dictationStatusSchema = z
  .object({
    phase: z.enum(["idle", "starting", "recording", "transcribing"]),
    ready: z.boolean(),
    error: z.string().max(1000).nullable(),
    lastTranscript: z.string().max(32000),
  })
  .strict();
export const cloudsyncLogResultSchema = z.string().max(110_000);
const context = new TextEncoder();

function encode(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function createPrivateActionIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  return {
    privateKey: pair.privateKey,
    publicKey: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
async function sharedKey(privateKey: CryptoKey, publicKey: string) {
  const peer = await crypto.subtle.importKey(
    "raw",
    decode(privateActionKeySchema.parse(publicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: peer },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(
  key: CryptoKey,
  value: unknown,
  direction: "request" | "response",
  kind: "auto-format" | "dictation-status" | "cloudsync-log",
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: context.encode(`shots-founder-hub:${kind}:${direction}`),
    },
    key,
    context.encode(JSON.stringify(value)),
  );
  return { iv: encode(iv), ciphertext: encode(ciphertext) };
}
async function open(
  key: CryptoKey,
  value: z.infer<typeof responseSchema>,
  direction: "request" | "response",
  kind: "auto-format" | "dictation-status" | "cloudsync-log",
): Promise<unknown> {
  const cleartext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(value.iv),
      additionalData: context.encode(`shots-founder-hub:${kind}:${direction}`),
    },
    key,
    decode(value.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(cleartext));
}
/** Each request has a fresh in-memory key; Shots only transports ciphertext. */
export async function sealAutoFormatRequest(
  publicKey: string,
  examples: string[],
) {
  const request = await sealPrivateRequest(
    publicKey,
    "auto-format",
    autoFormatExamplesSchema.parse(examples),
  );
  return {
    argument: request.argument,
    readResult: async (result: string) =>
      autoFormatResultSchema.parse(await request.readResult(result)),
  };
}

export async function sealDictationStatusRequest(publicKey: string) {
  const request = await sealPrivateRequest(publicKey, "dictation-status", {});
  return {
    argument: request.argument,
    readResult: async (result: string) =>
      dictationStatusSchema.parse(await request.readResult(result)),
  };
}

async function sealPrivateRequest(
  publicKey: string,
  kind: "auto-format" | "dictation-status" | "cloudsync-log",
  value: unknown,
) {
  const identity = await createPrivateActionIdentity();
  const key = await sharedKey(identity.privateKey, publicKey);
  return {
    argument: JSON.stringify({
      publicKey: identity.publicKey,
      ...(await seal(key, value, "request", kind)),
    }),
    readResult: async (result: string) =>
      open(key, responseSchema.parse(JSON.parse(result)), "response", kind),
  };
}
export async function openAutoFormatRequest(
  privateKey: CryptoKey,
  argument: string,
) {
  const request = await openPrivateRequest(privateKey, "auto-format", argument);
  return {
    examples: autoFormatExamplesSchema.parse(request.value),
    sealResult: (format: string) =>
      request.sealResult(autoFormatResultSchema.parse(format)),
  };
}

export async function openDictationStatusRequest(
  privateKey: CryptoKey,
  argument: string,
) {
  const request = await openPrivateRequest(
    privateKey,
    "dictation-status",
    argument,
  );
  z.object({}).strict().parse(request.value);
  return {
    sealResult: (status: z.infer<typeof dictationStatusSchema>) =>
      request.sealResult(dictationStatusSchema.parse(status)),
  };
}

export async function sealCloudsyncLogRequest(publicKey: string) {
  const request = await sealPrivateRequest(publicKey, "cloudsync-log", {});
  return {
    argument: request.argument,
    readResult: async (result: string) =>
      cloudsyncLogResultSchema.parse(await request.readResult(result)),
  };
}

export async function openCloudsyncLogRequest(
  privateKey: CryptoKey,
  argument: string,
) {
  const request = await openPrivateRequest(
    privateKey,
    "cloudsync-log",
    argument,
  );
  z.object({}).strict().parse(request.value);
  return {
    sealResult: (log: string) =>
      request.sealResult(cloudsyncLogResultSchema.parse(log)),
  };
}

async function openPrivateRequest(
  privateKey: CryptoKey,
  kind: "auto-format" | "dictation-status" | "cloudsync-log",
  argument: string,
) {
  const envelope = envelopeSchema.parse(JSON.parse(argument));
  const key = await sharedKey(privateKey, envelope.publicKey);
  return {
    value: await open(key, envelope, "request", kind),
    sealResult: async (value: unknown) =>
      JSON.stringify(await seal(key, value, "response", kind)),
  };
}
