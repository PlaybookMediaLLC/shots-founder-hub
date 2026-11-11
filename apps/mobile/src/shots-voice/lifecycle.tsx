import { AppState } from "react-native";

import { useMountEffect } from "@/lib/use-mount-effect";
import { shouldSyncAfterAppStateChange } from "@/sync/app-state";

import { requestShotsVoiceSync, stopShotsVoiceSync } from "./runner";
import { activateShotsVoice } from "./store";

const PERIODIC_SYNC_MS = 10 * 60_000;

/** Loads the signed-in account's Shots voice queue and syncs it on open and return (no push: plan K23 is out of scope). */
export function ShotsVoiceLifecycle({
  accountUserId,
}: {
  accountUserId: string;
}) {
  useMountEffect(() => {
    void activateShotsVoice(accountUserId).then(requestShotsVoiceSync);
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      if (shouldSyncAfterAppStateChange(previous, next))
        requestShotsVoiceSync();
      previous = next;
    });
    const interval = setInterval(() => {
      if (AppState.currentState === "active") requestShotsVoiceSync();
    }, PERIODIC_SYNC_MS);
    return () => {
      subscription.remove();
      clearInterval(interval);
      stopShotsVoiceSync();
      // Sign-out keeps the queue on this phone; signing in again as this account resumes it (S11).
      void activateShotsVoice(null);
    };
  });
  return null;
}
