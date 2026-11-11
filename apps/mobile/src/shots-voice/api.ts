import { getShotsCloudUrl } from "@anlg/supabase/shots";

import type { VoiceRequest } from "./engine.ts";

const TIMEOUT_MS = 30_000;

/**
 * Calls Shots' voice API through the gateway: `<apiUrl>/cloud/voice/<suffix>`
 * with the signed-in Shots session and the workspace the queue belongs to.
 * Statuses pass through; a network failure or timeout throws.
 */
export async function voiceFetch(input: {
  apiUrl: string;
  accessToken: string;
  workspaceId: string;
  request: VoiceRequest;
  fetch?: typeof fetch;
}): Promise<{ status: number; body: unknown }> {
  const { request } = input;
  const path = request.suffix.split("/").map(encodeURIComponent).join("/");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (input.fetch ?? fetch)(
      `${getShotsCloudUrl(input.apiUrl)}/voice/${path}`,
      {
        method: request.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
          "X-Shots-Organization-Id": input.workspaceId,
        },
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
