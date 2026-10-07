import type { SubscriptionState } from "@/lib/subscription-state";

// Which save offer a cancelling customer sees. Pure, so the page that renders
// the dialog and the server action that applies the decision pick the same
// offer from the same facts. The server always re-picks; the browser never
// tells it which offer was shown.
//
// One offer per customer, ever: a restarted subscription does not earn another.
// A trial is offered time, never money: a discount on a product someone has not
// used yet saves nobody. A paying customer is offered what their reason asks
// for. A customer whose renewal already failed gets that month forgiven: a
// coupon only discounts next month and would leave this one owed.

export const TRIAL_REASONS = {
  setup: "Couldn't get it set up",
  no_time: "Haven't had time to try it properly",
  no_results_yet: "Didn't see results yet",
  too_expensive: "Too expensive for me right now",
  not_expected: "Not what I expected",
  switched: "Switching to another tool",
  other: "Something else",
} as const;

export const PAID_REASONS = {
  no_results: "Not getting enough value",
  too_expensive: "Too expensive",
  pausing: "Pausing for now",
  switched: "Switching to another tool",
  missing_feature: "Missing a feature I need",
  hard_to_use: "Hard to set up or use",
  other: "Something else",
} as const;

export type CancelReason = keyof typeof TRIAL_REASONS | keyof typeof PAID_REASONS;

// The one follow-up question, asked only after these reasons. The answer is
// stored with the cancellation so you learn the price, the competitor or the
// missing feature, not just the category.
export const FOLLOW_UP_QUESTIONS: Partial<Record<CancelReason, string>> = {
  too_expensive: "What would you pay per month?",
  switched: "Which tool are you switching to?",
  missing_feature: "Which feature do you need?",
};

export type SaveOffer =
  | { kind: "extend_trial"; days: number }
  | { kind: "discount"; percentOff: number; months: number }
  | { kind: "pause"; months: number }
  | { kind: "waive_invoice" };

export interface OfferPolicy {
  trialExtensionDays: number;
  // A trial can never run longer than this many days in total, extensions included.
  maxTrialDays: number;
  discount: { percentOff: number; months: number };
  pauseMonths: number;
  // Cancelling within this many hours of a charge offers it back in full.
  refundWindowHours: number;
}

export const DEFAULT_OFFER_POLICY: OfferPolicy = {
  trialExtensionDays: 7,
  maxTrialDays: 14,
  discount: { percentOff: 50, months: 2 },
  pauseMonths: 1,
  refundWindowHours: 24,
};

export function isCancelReason(state: SubscriptionState, value: unknown): value is CancelReason {
  const reasons = state === "trialing" ? TRIAL_REASONS : PAID_REASONS;
  return typeof value === "string" && Object.hasOwn(reasons, value);
}

export function pickOffer(input: {
  state: SubscriptionState;
  reason: CancelReason;
  // True once this customer has accepted any save offer, on any subscription.
  offerUsed: boolean;
  policy?: OfferPolicy;
}): SaveOffer | null {
  const policy = input.policy ?? DEFAULT_OFFER_POLICY;
  if (input.offerUsed) return null;
  if (input.state === "trialing") {
    return { kind: "extend_trial", days: policy.trialExtensionDays };
  }
  if (input.state === "past_due") return { kind: "waive_invoice" };
  if (input.state !== "active") return null;
  if (input.reason === "pausing") return { kind: "pause", months: policy.pauseMonths };
  if (input.reason === "too_expensive") return { kind: "discount", ...policy.discount };
  // Everything else gets a free month: the time to fix what went wrong.
  return { kind: "discount", percentOff: 100, months: 1 };
}

// Adds the days to whatever is left of the trial, but never past the total cap
// counted from the trial's start.
export function extendedTrialEnd(
  subscription: { trial_start: number | null; trial_end: number | null },
  days: number,
  maxTrialDays: number,
  now: Date = new Date(),
): number {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const base = Math.max(subscription.trial_end ?? nowSeconds, nowSeconds);
  const wanted = base + days * 86_400;
  const cap = (subscription.trial_start ?? nowSeconds) + maxTrialDays * 86_400;
  return Math.max(base, Math.min(wanted, cap));
}

// Whether a charge paid at `paidAt` may still be refunded in the cancel flow.
export function isWithinRefundWindow(paidAt: Date, now: Date, windowHours: number): boolean {
  const age = now.getTime() - paidAt.getTime();
  return age >= 0 && age <= windowHours * 3_600_000;
}

export function describeOffer(offer: SaveOffer): string {
  switch (offer.kind) {
    case "waive_invoice":
      return "Take this month free";
    case "extend_trial":
      return `Add ${offer.days} days to my trial`;
    case "pause":
      return offer.months === 1 ? "Pause for a month instead" : `Pause for ${offer.months} months instead`;
    case "discount":
      if (offer.percentOff === 100) {
        return offer.months === 1 ? "Take next month free" : `Take ${offer.months} months free`;
      }
      return `Take ${offer.percentOff}% off for ${offer.months} months`;
  }
}
