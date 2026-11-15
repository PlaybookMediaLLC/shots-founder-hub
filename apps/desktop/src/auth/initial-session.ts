import type { Session, CloudClient } from "@anlg/cloud-client";

import { readPersistedAuthSession } from "./client";

export async function loadInitialSession(
  client: CloudClient,
  onRefreshError?: (error: unknown, storedSession: Session | null) => void,
): Promise<Session | null> {
  const storedSession = await readPersistedAuthSession();

  try {
    const { data, error } = await client.auth.getSession();

    if (error) {
      onRefreshError?.(error, storedSession);
      return storedSession;
    }

    return data.session ?? storedSession;
  } catch (error) {
    onRefreshError?.(error, storedSession);
    return storedSession;
  }
}
