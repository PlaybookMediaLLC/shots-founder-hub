import { useQuery } from "@tanstack/react-query";
import { arch, platform } from "@tauri-apps/plugin-os";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { deriveBillingInfo, type SessionClaims } from "@anlg/cloud-client";
import { commands as analyticsCommands } from "@anlg/plugin-analytics";
import { commands as openerCommands } from "@anlg/plugin-opener2";
import { openUrlWithInstruction } from "@anlg/plugin-windows";

import { configurePaidSettings } from "../shared/config/configure-paid-settings";
import { buildWebAppUrl } from "../shared/utils";
import { useAuth } from "./auth-context";
import { type BillingAccess, BillingContext } from "./billing-context";
import { cloudClient } from "./client";

import { setSettingValues } from "~/settings/queries";
import { useConfigValues } from "~/shared/config";
import { getUnsupportedDesktopLocalSttRepair } from "~/stt/capabilities";

async function getClaimsFromToken(
  accessToken: string,
): Promise<SessionClaims | null> {
  if (!cloudClient) return null;
  const { data, error } = await cloudClient.claims(accessToken);
  if (error) throw error;
  return data;
}

export function BillingProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const {
    current_llm_provider: currentLlmProvider,
    current_stt_provider: currentSttProvider,
    current_stt_model: currentSttModel,
  } = useConfigValues([
    "current_llm_provider",
    "current_stt_provider",
    "current_stt_model",
  ] as const);

  const claimsQuery = useQuery({
    queryKey: ["tokenInfo", auth?.session?.access_token ?? ""],
    queryFn: () => getClaimsFromToken(auth!.session!.access_token),
    enabled: !!auth?.session?.access_token,
    placeholderData: (previous) =>
      previous?.sub === auth?.session?.user.id ? previous : undefined,
  });

  const billing = deriveBillingInfo(claimsQuery.data ?? null);
  const isReady = !claimsQuery.isPending && !claimsQuery.isError;
  const claimsAreCurrent =
    !claimsQuery.isFetching && !claimsQuery.isPlaceholderData;
  const canStartTrial = { data: false, isPending: false };

  const [isUpgradingToPro, setIsUpgradingToPro] = useState(false);
  // State alone cannot gate re-entry: a second click can land before the
  // disabled state renders, and its finally would re-enable the buttons
  // while the first open is still in flight.
  const upgradeInFlightRef = useRef(false);

  const openUpgrade = useCallback(
    async (source: "feature_gate" | "trial_ended") => {
      if (upgradeInFlightRef.current) {
        return;
      }
      upgradeInFlightRef.current = true;

      void analyticsCommands.event({
        event: "upgrade_clicked",
        plan: "pro",
        period: "monthly",
        source,
      });

      setIsUpgradingToPro(true);
      try {
        const url = await buildWebAppUrl("/app/checkout", { source });
        await openUrlWithInstruction(url, "billing", (u) =>
          openerCommands.openUrl(u, null),
        );
      } finally {
        upgradeInFlightRef.current = false;
        setIsUpgradingToPro(false);
      }
    },
    [],
  );

  const upgradeToPro = useCallback(() => {
    void openUpgrade("feature_gate");
  }, [openUpgrade]);

  useEffect(() => {
    if (
      !auth?.session?.user.id ||
      !isReady ||
      !claimsAreCurrent ||
      billing.isPaid
    ) {
      return;
    }

    if (currentLlmProvider !== "anarlog") {
      return;
    }

    void setSettingValues({
      current_llm_provider: "",
      current_llm_model: "",
    });
  }, [
    auth?.session?.user.id,
    billing.isPaid,
    claimsAreCurrent,
    currentLlmProvider,
    isReady,
  ]);

  useEffect(() => {
    if (
      auth.session === undefined ||
      (auth.session !== null && (!isReady || !claimsAreCurrent))
    ) {
      return;
    }

    const repair = getUnsupportedDesktopLocalSttRepair(
      platform(),
      arch(),
      currentSttProvider,
      currentSttModel,
      isReady && billing.isPaid && !!auth?.session,
    );
    if (!repair) {
      return;
    }

    void setSettingValues({
      current_stt_provider: repair.provider,
      current_stt_model: repair.model,
    });
  }, [
    auth.session,
    billing.isPaid,
    claimsAreCurrent,
    currentSttModel,
    currentSttProvider,
    isReady,
  ]);

  const prevIsPaidRef = useRef(billing.isPaid);
  useEffect(() => {
    const wasPaid = prevIsPaidRef.current;
    prevIsPaidRef.current = billing.isPaid;

    if (!wasPaid && billing.isPaid && isReady) {
      void configurePaidSettings();
    }
  }, [billing.isPaid, isReady]);

  const value = useMemo<BillingAccess>(
    () => ({
      ...billing,
      isReady,
      canStartTrial,
      upgradeToPro,
      isUpgradingToPro,
    }),
    [billing, isReady, canStartTrial, upgradeToPro, isUpgradingToPro],
  );

  return (
    <BillingContext.Provider value={value}>{children}</BillingContext.Provider>
  );
}
