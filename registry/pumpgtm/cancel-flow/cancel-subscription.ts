import "server-only";
import type Stripe from "stripe";
import { subscriptionState, canCancel } from "@/lib/subscription-state";
import {
  DEFAULT_OFFER_POLICY,
  extendedTrialEnd,
  isCancelReason,
  isWithinRefundWindow,
  pickOffer,
  type CancelReason,
  type OfferPolicy,
  type SaveOffer,
} from "@/lib/cancel-offer";

// The cancel flow's only server code. Call it from your own server action
// after you have authenticated the user and looked up THEIR subscription id;
// never take a subscription id from the browser.
//
// Everything is recorded on Stripe itself, so there is no table to migrate:
// the reason goes into Stripe's own `cancellation_details` and the offer shown,
// and what the customer did with it, into the subscription's metadata.
// Cancelling cancels here instead of sending people to the billing portal,
// where cancellations can silently fail to land.

export interface CancelRequest {
  reason: string;
  // The answer to the reason's follow-up question, if it has one.
  followUp?: string | null;
  comment?: string | null;
  decision: "accept_offer" | "refund" | "cancel";
}

export type CancelResult =
  | { outcome: "saved"; offer: SaveOffer }
  | { outcome: "refunded"; amountCents: number; currency: string }
  | { outcome: "cancelled"; accessEndsAt: Date | null }
  | {
      outcome: "invalid";
      error: "not_cancellable" | "invalid_reason" | "offer_unavailable" | "refund_unavailable";
    };

export interface RefundableCharge {
  amountCents: number;
  currency: string;
  paidAt: Date;
}

const METADATA = {
  shown: "retention_offer_shown",
  accepted: "retention_offer_accepted",
  coupon: "retention_offer_coupon",
  reason: "cancel_reason",
  followUp: "cancel_follow_up",
} as const;

// One save offer per customer, ever: a cancelled-and-restarted subscription
// does not earn a second one.
export async function offerUsed(stripe: Stripe, customerId: string): Promise<boolean> {
  for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: "all" })) {
    if (subscription.metadata?.[METADATA.accepted]) return true;
  }
  return false;
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
  const followUp = request.followUp?.trim().slice(0, 200) || null;
  const comment = [followUp, request.comment?.trim()].filter(Boolean).join("\n").slice(0, 1000) || null;
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const offer = pickOffer({ state, reason, offerUsed: await offerUsed(stripe, customerId), policy });
  const shown = offer ? offerKey(offer) : null;
  const metadata = {
    ...(shown ? { [METADATA.shown]: shown } : {}),
    [METADATA.reason]: reason,
    ...(followUp ? { [METADATA.followUp]: followUp } : {}),
  };
  const details = { feedback: stripeFeedback(reason), ...(comment ? { comment } : {}) };

  if (request.decision === "accept_offer") {
    // Someone who clicked "accept" is never cancelled because the offer went
    // away in the meantime (used in another tab, or the subscription changed).
    if (!offer) return { outcome: "invalid", error: "offer_unavailable" };
    const params = await offerParams(stripe, subscription, offer, policy);
    await stripe.subscriptions.update(subscriptionId, {
      ...params.update,
      metadata: {
        ...metadata,
        [METADATA.accepted]: `${shown}@${new Date().toISOString()}`,
        ...(params.couponId ? { [METADATA.coupon]: params.couponId } : {}),
      },
    });
    return { outcome: "saved", offer };
  }

  if (request.decision === "refund") {
    // Rechecked here, so a stale page cannot refund an old charge.
    const charge = await latestPaidCharge(stripe, subscription);
    if (!charge || !isWithinRefundWindow(charge.paidAt, new Date(), policy.refundWindowHours)) {
      return { outcome: "invalid", error: "refund_unavailable" };
    }
    // One refund per payment, however many times the button is pressed.
    await stripe.refunds.create(
      { ...charge.target, reason: "requested_by_customer" },
      { idempotencyKey: `cancel-refund:${charge.paymentId}` },
    );
    // A refunded period keeps no access.
    await endNow(stripe, subscriptionId, metadata, details);
    return { outcome: "refunded", amountCents: charge.amountCents, currency: charge.currency };
  }

  // A failed payment is not a period to run out: void what it owes so Stripe
  // stops retrying the card, and end it now.
  if (state === "past_due") {
    await voidOpenInvoice(stripe, subscription);
    await endNow(stripe, subscriptionId, metadata, details);
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

// The charge a cancelling customer may still get back, for the dialog's
// `refund` prop. Null when there is none inside the policy's window.
export async function refundableCharge(
  stripe: Stripe,
  subscriptionId: string,
  policy: OfferPolicy = DEFAULT_OFFER_POLICY,
): Promise<RefundableCharge | null> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (!canCancel(subscriptionState(subscription))) return null;
  const charge = await latestPaidCharge(stripe, subscription);
  if (!charge || !isWithinRefundWindow(charge.paidAt, new Date(), policy.refundWindowHours)) return null;
  return { amountCents: charge.amountCents, currency: charge.currency, paidAt: charge.paidAt };
}

// Takes back a scheduled cancellation, for the "Keep my subscription" button a
// cancelling customer sees instead of the cancel flow. Clears both forms:
// this flow sets cancel_at_period_end, the Stripe portal may set cancel_at.
export async function resumeSubscription(stripe: Stripe, subscriptionId: string): Promise<void> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await stripe.subscriptions.update(
    subscriptionId,
    subscription.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: "" },
  );
}

// A customer who took a free month and cancelled before any invoice used it
// still has that month. Pass the returned coupon id to the Checkout session
// that restarts them; null when there is nothing to carry over. The original
// coupon is single-use, so a fresh one is created.
export async function unusedFreeMonthCoupon(
  stripe: Stripe,
  endedSubscriptionId: string,
): Promise<string | null> {
  const ended = await stripe.subscriptions.retrieve(endedSubscriptionId, { expand: ["discounts"] });
  const couponId = ended.metadata?.[METADATA.coupon];
  if (!couponId || !ended.metadata?.[METADATA.accepted]?.startsWith("discount_100pct_1m")) return null;
  // Stripe removes a once-coupon from the subscription when an invoice uses it.
  const stillAttached = (ended.discounts ?? []).some((discount) => {
    const coupon = typeof discount === "string" ? null : discount.source?.coupon;
    return (typeof coupon === "string" ? coupon : coupon?.id) === couponId;
  });
  if (!stillAttached) return null;
  return (await createSaveCoupon(stripe, 100, 1)).id;
}

async function offerParams(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  offer: SaveOffer,
  policy: OfferPolicy,
): Promise<{ update: Stripe.SubscriptionUpdateParams; couponId?: string }> {
  switch (offer.kind) {
    case "extend_trial":
      return {
        update: {
          trial_end: extendedTrialEnd(subscription, offer.days, policy.maxTrialDays),
          proration_behavior: "none",
        },
      };
    case "pause": {
      const resumesAt = new Date();
      resumesAt.setMonth(resumesAt.getMonth() + offer.months);
      return {
        update: {
          pause_collection: { behavior: "void", resumes_at: Math.floor(resumesAt.getTime() / 1000) },
        },
      };
    }
    case "waive_invoice":
      // Voiding the failed invoice forgives this month and returns the
      // subscription to active; the next renewal bills as usual.
      await voidOpenInvoice(stripe, subscription);
      return { update: {} };
    case "discount": {
      const coupon = await createSaveCoupon(stripe, offer.percentOff, offer.months);
      return {
        update: { discounts: [...existingDiscounts(subscription), { coupon: coupon.id }] },
        couponId: coupon.id,
      };
    }
  }
}

// Ends the subscription now. A second request racing the first (another tab)
// finds it already ended and reports the same outcome instead of an error.
async function endNow(
  stripe: Stripe,
  subscriptionId: string,
  metadata: Record<string, string>,
  details: Stripe.SubscriptionCancelParams.CancellationDetails,
): Promise<void> {
  try {
    await stripe.subscriptions.update(subscriptionId, { metadata });
    await stripe.subscriptions.cancel(subscriptionId, { cancellation_details: details });
  } catch (error) {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    if (current.status !== "canceled") throw error;
  }
}

function createSaveCoupon(stripe: Stripe, percentOff: number, months: number) {
  return stripe.coupons.create({
    percent_off: percentOff,
    duration: months === 1 ? "once" : "repeating",
    ...(months === 1 ? {} : { duration_in_months: months }),
    max_redemptions: 1,
    name: `Save offer: ${percentOff}% off`,
  });
}

async function voidOpenInvoice(stripe: Stripe, subscription: Stripe.Subscription): Promise<void> {
  const invoiceId =
    typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id;
  if (!invoiceId) return;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.status === "open") await stripe.invoices.voidInvoice(invoiceId);
}

// The latest invoice's successful payment, if it has not been refunded.
async function latestPaidCharge(stripe: Stripe, subscription: Stripe.Subscription) {
  const invoiceId =
    typeof subscription.latest_invoice === "string" ? subscription.latest_invoice : subscription.latest_invoice?.id;
  if (!invoiceId) return null;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const paidAt = invoice.status_transitions?.paid_at;
  if (invoice.status !== "paid" || !paidAt || invoice.amount_paid <= 0) return null;
  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: "paid", limit: 1 });
  const payment = payments.data[0]?.payment;
  const intent = typeof payment?.payment_intent === "string" ? payment.payment_intent : payment?.payment_intent?.id;
  const chargeId = typeof payment?.charge === "string" ? payment.charge : payment?.charge?.id;
  const target = intent ? { payment_intent: intent } : chargeId ? { charge: chargeId } : null;
  if (!target) return null;
  const refunds = await stripe.refunds.list({ ...target, limit: 1 });
  if (refunds.data.length > 0) return null;
  return {
    target,
    paymentId: intent ?? chargeId!,
    amountCents: invoice.amount_paid,
    currency: invoice.currency,
    paidAt: new Date(paidAt * 1000),
  };
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
    case "waive_invoice":
      return "waive_invoice";
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
