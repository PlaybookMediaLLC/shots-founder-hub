import { createServerOnlyFn } from "@tanstack/react-start";
import Stripe from "stripe";

import { env, requireEnv } from "@/env";

export const getStripeClient = createServerOnlyFn(() => {
  if (env.VITE_SHOTS_URL)
    throw new Error("Plans and payments are managed by Shots.");
  return new Stripe(requireEnv(env.STRIPE_SECRET_KEY, "STRIPE_SECRET_KEY"), {
    apiVersion: "2026-02-25.clover",
  });
});
