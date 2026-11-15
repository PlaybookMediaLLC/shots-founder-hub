import { useQueryClient } from "@tanstack/react-query";

import type { Session } from "@anlg/cloud-client";
import { createAttachmentBackupClient } from "@anlg/cloud-client/attachment-backups";
import { useMountEffect } from "@anlg/ui/hooks/use-mount-effect";

import { startAttachmentTransferRunner } from "./runner";

import { useAuth } from "~/auth";
import { useBillingAccess } from "~/auth/billing-context";
import { env } from "~/env";
import { sessionAttachmentPathsQueryKey } from "~/session/hooks/useAttachmentResolver";
import { useConfigValue } from "~/shared/config";
import { useLatestRef } from "~/shared/hooks/useLatestRef";

export function AttachmentTransferLifecycle() {
  const auth = useAuth();
  const billing = useBillingAccess();
  const cloudSyncEnabled = useConfigValue("cloud_sync_enabled");
  const session = auth.session;
  const cloudUrl = env.VITE_CLOUD_URL;

  if (
    !session ||
    session.user.is_anonymous === true ||
    !billing.isPaid ||
    !cloudSyncEnabled ||
    !cloudUrl
  ) {
    return null;
  }

  return (
    <ActiveAttachmentTransferLifecycle
      key={session.user.id}
      session={session}
      cloudUrl={cloudUrl}
    />
  );
}

function ActiveAttachmentTransferLifecycle({
  session,
  cloudUrl,
}: {
  session: Session;
  cloudUrl: string;
}) {
  const queryClient = useQueryClient();
  const accessTokenRef = useLatestRef(session.access_token);

  useMountEffect(() =>
    startAttachmentTransferRunner({
      client: createAttachmentBackupClient({
        apiBaseUrl: env.VITE_API_URL,
        getAccessToken: () => accessTokenRef.current,
      }),
      cloudUrl,
      onAttachmentRestored: ({ sessionId }) => {
        void queryClient.invalidateQueries({
          queryKey: sessionAttachmentPathsQueryKey(sessionId),
        });
      },
    }),
  );

  return null;
}
