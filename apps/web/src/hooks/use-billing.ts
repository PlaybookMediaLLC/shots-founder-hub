import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { type BillingInfo, deriveBillingInfo } from "@anlg/cloud-client";

import { getCloudBrowserClient } from "@/functions/cloud-client";
import { useMountEffect } from "@/hooks/useMountEffect";

const DEFAULT_BILLING = deriveBillingInfo(null);

async function deriveBillingFromAccessToken(accessToken: string) {
  const { data, error } = await getCloudBrowserClient().claims(accessToken);
  if (error) throw error;
  return deriveBillingInfo(data);
}

export function useBilling() {
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState<string | null | undefined>(
    undefined,
  );

  useMountEffect(() => {
    const cloudClient = getCloudBrowserClient();

    void cloudClient.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null);
    });

    const {
      data: { subscription },
    } = cloudClient.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  });

  const jwtQuery = useQuery({
    queryKey: ["billing", "jwt", accessToken ?? ""],
    queryFn: async () => {
      if (!accessToken) {
        return DEFAULT_BILLING;
      }

      return deriveBillingFromAccessToken(accessToken);
    },
    enabled: accessToken !== undefined,
    retry: false,
  });

  const billing: BillingInfo = jwtQuery.data ?? DEFAULT_BILLING;
  const isReady =
    accessToken !== undefined && !jwtQuery.isPending && !jwtQuery.isError;
  const isVerified = isReady;

  const refreshBilling = useCallback(async () => {
    const cloudClient = getCloudBrowserClient();
    const { data, error } = await cloudClient.auth.refreshSession();

    if (error) {
      throw error;
    }

    const refreshedAccessToken = data.session?.access_token;

    if (!refreshedAccessToken) {
      throw new Error("Billing refresh returned no authenticated session");
    }

    const refreshedBilling =
      await deriveBillingFromAccessToken(refreshedAccessToken);
    setAccessToken(refreshedAccessToken);
    await queryClient.invalidateQueries({ queryKey: ["billing", "jwt"] });

    return refreshedBilling;
  }, [queryClient]);

  return {
    ...billing,
    isReady,
    isVerified,
    refreshBilling,
  };
}
