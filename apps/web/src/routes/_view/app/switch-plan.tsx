import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getShotsSettingsUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";
import { desktopSchemeSchema } from "@/functions/desktop-flow";

const validateSearch = z.object({
  targetPlan: z.enum(["pro"]).catch("pro").optional(),
  targetPeriod: z.enum(["monthly", "yearly"]).catch("monthly"),
  scheme: desktopSchemeSchema.optional(),
});

export const Route = createFileRoute("/_view/app/switch-plan")({
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
