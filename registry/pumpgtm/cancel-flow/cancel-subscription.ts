import "server-only";
import type Stripe from "stripe";
import { subscriptionState, canCancel } from "@/lib/subscription-state";
import {
  DEFAULT_OFFER_POLICY,
  extendedTrialEnd,
  isCancelReason,
  pickOffer,
  type CancelReason,
  type OfferPolicy,
  type SaveOffer,
} from "@/lib/cancel-offer";

// The cancel flow's only server code. Call it from your own server action
// after you have authenticated the user and looked up THEIR subscription id;
// never take a subscription id from the browser.
//
// Everything is recorded on the Stripe subscription itself, so there is no
// table to migrate: the reason goes into Stripe's own `cancellation_details`
// and the offer shown, and what the customer did with it, into metadata.
// Cancelling cancels here, at period end, instead of sending people to the
// billing portal, where cancellations can silently fail to land.

export interface CancelRequest {
  reason: string;
  comment?: string | null;
  decision: "accept_offer" | "cancel";
}

export type CancelResult =
  | { outcome: "saved"; offer: SaveOffer }
  | { outcome: "cancelled"; accessEndsAt: Date | null }
  | { outcome: "invalid"; error: "not_cancellable" | "invalid_reason" | "offer_unavailable" };

const METADATA = {
  shown: "retention_offer_shown",
  accepted: "retention_offer_accepted",
  reason: "cancel_reason",
} as const;

export function offerUsed(subscription: Pick<Stripe.Subscription, "metadata">): boolean {
  return Boolean(subscription.metadata?.[METADATA.accepted]);
}

export async function cancelSubscription(
  stripe: Stripe,
  subscriptionId: string,
  request: CancelRequest,
  policy: OfferPolicy = DEFAULT_OFFER_POLICY,
): Promise<CancelResult> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const state = subscriptionState(subscription);
  if (!canCancel(state)) return { outcome: "invalid", error: "not_cancellable" };
  if (!isCancelReason(state, request.reason)) return { outcome: "invalid", error: "invalid_reason" };
  const reason = request.reason;
  const comment = request.comment?.trim().slice(0, 500) || null;
  const offer = pickOffer({ state, reason, offerUsed: offerUsed(subscription), policy });
  const shown = offer ? offerKey(offer) : null;

  // Someone who clicked "accept" is never cancelled because the offer went
  // away in the meantime (used in another tab, or the subscription changed).
  if (request.decision === "accept_offer" && !offer) {
    return { outcome: "invalid", error: "offer_unavailable" };
  }
  if (request.decision === "accept_offer" && offer) {
    await stripe.subscriptions.update(subscriptionId, {
      ...(await offerParams(stripe, subscription, offer, policy)),
      metadata: {
        [METADATA.shown]: shown!,
        [METADATA.accepted]: `${shown}@${new Date().toISOString()}`,
        [METADATA.reason]: reason,
      },
    });
    return { outcome: "saved", offer };
  }

  const details = {
    feedback: stripeFeedback(reason),
    ...(comment ? { comment } : {}),
  };
  const metadata = { ...(shown ? { [METADATA.shown]: shown } : {}), [METADATA.reason]: reason };
  // A failed payment is not a period to run out: end it now so Stripe stops
  // retrying the card.
  if (state === "past_due") {
    await stripe.subscriptions.update(subscriptionId, { metadata });
    await stripe.subscriptions.cancel(subscriptionId, { cancellation_details: details });
    return { outcome: "cancelled", accessEndsAt: new Date() };
  }
  const updated = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
    cancellation_details: details,
    metadata,
    // A paused subscription that cancels must not stay paused forever.
    ...(state === "paused" ? { pause_collection: "" as const } : {}),
  });
  return {
    outcome: "cancelled",
    accessEndsAt: updated.cancel_at ? new Date(updated.cancel_at * 1000) : null,
  };
}

// Takes back a scheduled cancellation, for the "Resume" button a cancelling
// customer sees instead of the cancel flow.
export async function resumeSubscription(stripe: Stripe, subscriptionId: string): Promise<void> {
  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

async function offerParams(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  offer: SaveOffer,
  policy: OfferPolicy,
): Promise<Stripe.SubscriptionUpdateParams> {
  switch (offer.kind) {
    case "extend_trial":
      return {
        trial_end: extendedTrialEnd(subscription, offer.days, policy.maxTrialDays),
        proration_behavior: "none",
      };
    case "pause": {
      const resumesAt = new Date();
      resumesAt.setMonth(resumesAt.getMonth() + offer.months);
      return {
        pause_collection: { behavior: "void", resumes_at: Math.floor(resumesAt.getTime() / 1000) },
      };
    }
    case "discount": {
      const coupon = await stripe.coupons.create({
        percent_off: offer.percentOff,
        duration: offer.months === 1 ? "once" : "repeating",
        ...(offer.months === 1 ? {} : { duration_in_months: offer.months }),
        max_redemptions: 1,
        name: `Save offer: ${offer.percentOff}% off`,
      });
      return { discounts: [...existingDiscounts(subscription), { coupon: coupon.id }] };
    }
  }
}

function existingDiscounts(subscription: Stripe.Subscription): Array<{ discount: string }> {
  return (subscription.discounts ?? []).map((discount) => ({
    discount: typeof discount === "string" ? discount : discount.id,
  }));
}

function offerKey(offer: SaveOffer): string {
  switch (offer.kind) {
    case "extend_trial":
      return `extend_trial_${offer.days}d`;
    case "pause":
      return `pause_${offer.months}m`;
    case "discount":
      return `discount_${offer.percentOff}pct_${offer.months}m`;
  }
}

// Stripe's own vocabulary, so the reason shows up in the Dashboard and in
// Stripe's churn reporting without any work on your side.
function stripeFeedback(
  reason: CancelReason,
): Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback {
  switch (reason) {
    case "too_expensive":
      return "too_expensive";
    case "switched":
      return "switched_service";
    case "missing_feature":
      return "missing_features";
    case "hard_to_use":
    case "setup":
      return "too_complex";
    case "no_time":
    case "pausing":
      return "unused";
    case "no_results":
    case "no_results_yet":
    case "not_expected":
      return "low_quality";
    default:
      return "other";
  }
}
