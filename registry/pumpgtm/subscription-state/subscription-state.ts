// The one place a Stripe subscription becomes a product decision. Every gate
// (feature access, the billing wall, the cancel button) should read this
// instead of comparing `status` strings on its own.

export type SubscriptionState =
  | "needs_card" // no subscription, checkout unfinished, or a trial ended without a card
  | "trialing"
  | "trial_canceling" // cancelled during the trial: the trial still runs to its end
  | "active"
  | "canceling" // cancelled while paid: the paid period still runs to its end
  | "paused" // collection paused as a save offer; resumes on its own
  | "past_due"
  | "ended";

// The fields this needs, so a stored copy of the subscription works as well as
// a live Stripe object. Stripe timestamps are seconds.
export interface SubscriptionSnapshot {
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  trial_end: number | null;
  pause_collection?: { resumes_at: number | null } | null;
}

export function subscriptionState(
  subscription: SubscriptionSnapshot | null | undefined,
  now: Date = new Date(),
): SubscriptionState {
  if (!subscription) return "needs_card";
  const nowSeconds = now.getTime() / 1000;
  const scheduledToCancel =
    subscription.cancel_at_period_end || subscription.cancel_at != null;
  switch (subscription.status) {
    case "trialing":
      // A stored copy can outlive the trial it describes.
      if (subscription.trial_end != null && subscription.trial_end <= nowSeconds) return "ended";
      return scheduledToCancel ? "trial_canceling" : "trialing";
    case "active":
      if (subscription.pause_collection) return "paused";
      return scheduledToCancel ? "canceling" : "active";
    // `unpaid` is a past-due subscription Stripe stopped retrying. It still owes
    // money and still has to be cancellable.
    case "past_due":
    case "unpaid":
      return "past_due";
    // `paused` is Stripe's status for a trial that ended with no payment method.
    case "incomplete":
    case "paused":
      return "needs_card";
    default:
      // canceled, incomplete_expired
      return "ended";
  }
}

// A scheduled cancellation keeps access until Stripe ends the subscription:
// people cancel minutes after starting a trial so they are not charged, and
// the trial they were promised must still work.
export function hasAccess(state: SubscriptionState): boolean {
  return (
    state === "trialing" ||
    state === "trial_canceling" ||
    state === "active" ||
    state === "canceling"
  );
}

// Who may open the cancel flow. Someone already cancelling resumes instead.
// A failed payment must never trap anyone: past_due can always cancel.
export function canCancel(state: SubscriptionState): boolean {
  return state === "trialing" || state === "active" || state === "paused" || state === "past_due";
}
