import { createFileRoute, redirect } from "@tanstack/react-router";

import { getShotsSettingsUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";
import { fetchUser } from "@/functions/auth";
import { privateShareHeaders } from "@/lib/shared-note-meta";

// Shots owns workspaces, members, and invitations, so older invitation links
// open Shots. The invitation ID is not forwarded, and the empty fragment stops
// the browser from copying the old "#token=" onto the Shots URL.
export const Route = createFileRoute("/team/invite/$invitationId")({
  headers: () => privateShareHeaders,
  beforeLoad: async () => {
    const user = await fetchUser();
    throw redirect({
      href: `${
        user?.shotsUserId
          ? getShotsSettingsUrl(env.VITE_SHOTS_URL, user.shotsUserId, "members")
          : new URL("/", env.VITE_SHOTS_URL).toString()
      }#`,
    } as any);
  },
});
