import { Trans } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";

import { commands as openerCommands } from "@anlg/plugin-opener2";
import { Button } from "@anlg/ui/components/ui/button";

import { useAuth } from "~/auth";
import { SettingsPageTitle } from "~/settings/page-title";
import { buildWebAppUrl } from "~/shared/utils";
import { useTabs } from "~/store/zustand/tabs";

export function ShotsSettings({ section }: { section: "team" | "billing" }) {
  const auth = useAuth();
  const openNew = useTabs((state) => state.openNew);
  const open = useMutation({
    mutationFn: async () => {
      const url = await buildWebAppUrl(
        section === "team" ? "/app/team" : "/app/portal",
      );
      const result = await openerCommands.openUrl(url, null);
      if (result.status === "error") throw new Error(String(result.error));
    },
  });

  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle
        title={
          section === "team" ? <Trans>Teams</Trans> : <Trans>Billing</Trans>
        }
      />
      <p className="text-muted-foreground text-sm">
        {section === "team" ? (
          <Trans>Manage your teams, invitations, and roles in Shots.</Trans>
        ) : (
          <Trans>
            Your Shots workspace plan controls your Founder Hub access. Manage
            plans and payments in Shots.
          </Trans>
        )}
      </p>
      <Button
        className="self-start"
        disabled={open.isPending}
        onClick={() =>
          auth.session
            ? open.mutate()
            : openNew({ type: "settings", state: { tab: "account" } })
        }
      >
        {auth.session ? (
          <Trans>Open Shots settings</Trans>
        ) : (
          <Trans>Sign in to Shots</Trans>
        )}
      </Button>
      {open.error ? (
        <p role="alert" className="text-destructive text-sm">
          {open.error.message}
        </p>
      ) : null}
    </div>
  );
}
