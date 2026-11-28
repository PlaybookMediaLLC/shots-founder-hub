import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getShotsSettingsUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";
import { desktopSchemeSchema } from "@/functions/desktop-flow";

const validateSearch = z.object({
  scheme: desktopSchemeSchema.optional(),
  intent: z
    .enum(["manage", "payment_method_update"])
    .catch("manage")
    .optional(),
});

export const Route = createFileRoute("/_view/app/portal")({
  validateSearch,
  beforeLoad: ({ context }) => {
    throw redirect({
      href: getShotsSettingsUrl(
        env.VITE_SHOTS_URL,
        context.user?.shotsUserId ?? "",
        "billing",
      ),
    } as any);
  },
});
