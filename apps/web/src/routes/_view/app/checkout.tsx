import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getShotsSettingsUrl } from "@anlg/cloud-client/shots";

import { env } from "@/env";
import { desktopSchemeSchema } from "@/functions/desktop-flow";
import { checkoutSourceSchema } from "@/lib/checkout-source";

const validateSearch = z.object({
  period: z.enum(["monthly", "yearly"]).optional().catch(undefined),
  plan: z.enum(["pro"]).catch("pro").optional(),
  scheme: desktopSchemeSchema.optional(),
  trial: z
    .enum(["true", "false"])
    .catch("false")
    .transform((value) => value === "true"),
  source: checkoutSourceSchema.catch("unknown"),
  return_to: z.string().optional(),
  code: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export const Route = createFileRoute("/_view/app/checkout")({
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
