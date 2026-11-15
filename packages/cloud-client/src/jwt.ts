// Mirrors crates/session-auth/src/claims.rs SubscriptionStatus
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type SessionClaims = {
  sub?: string;
  email?: string;
  entitlements?: string[];
  subscription_status?: SubscriptionStatus | null;
  trial_end?: number | null;
  referral_extension?: boolean;
  has_payment_method?: boolean | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
};
