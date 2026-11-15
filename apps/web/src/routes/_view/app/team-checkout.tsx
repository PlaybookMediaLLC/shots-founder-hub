import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getShotsSettingsUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";
import { desktopSchemeSchema } from "@/functions/desktop-flow";

const validateSearch = z.object({
  workspace_id: z.string().uuid(),
  period: z.enum(["monthly", "yearly"]).catch("monthly"),
  quantity: z.coerce.number().int().positive().max(999_999),
  scheme: desktopSchemeSchema.optional(),
  return_to: z.string().optional(),
});

export const Route = createFileRoute("/_view/app/team-checkout")({
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
