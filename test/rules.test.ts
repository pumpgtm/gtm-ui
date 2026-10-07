import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canCancel,
  hasAccess,
  subscriptionState,
  type SubscriptionSnapshot,
} from "../registry/pumpgtm/subscription-state/subscription-state.ts";
import { extendedTrialEnd, isWithinRefundWindow, pickOffer } from "../registry/pumpgtm/cancel-flow/cancel-offer.ts";

const DAY = 86_400;
const now = new Date("2026-10-01T00:00:00Z");
const t = now.getTime() / 1000;
const sub = (over: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  ...over,
});

test("a trial cancelled minutes after it started keeps access until it ends", () => {
  const state = subscriptionState(sub({ status: "trialing", trial_end: t + 6 * DAY, cancel_at_period_end: true }), now);
  assert.equal(state, "trial_canceling");
  assert.equal(hasAccess(state), true);
  assert.equal(canCancel(state), false);
});

test("cancel_at alone also counts as scheduled", () => {
  assert.equal(subscriptionState(sub({ cancel_at: t + DAY }), now), "canceling");
});

test("a stored trial past its end is ended, not trialing", () => {
  assert.equal(subscriptionState(sub({ status: "trialing", trial_end: t - 1 }), now), "ended");
});

test("no subscription, unfinished checkout and Stripe's paused trial all ask for a card", () => {
  assert.equal(subscriptionState(null, now), "needs_card");
  assert.equal(subscriptionState(sub({ status: "incomplete" }), now), "needs_card");
  assert.equal(subscriptionState(sub({ status: "paused" }), now), "needs_card");
});

test("a pause offer is paused without access, and can still cancel", () => {
  const state = subscriptionState(sub({ pause_collection: { resumes_at: t + 30 * DAY } }), now);
  assert.equal(state, "paused");
  assert.equal(hasAccess(state), false);
  assert.equal(canCancel(state), true);
});

test("past due has no access but can always cancel", () => {
  const state = subscriptionState(sub({ status: "past_due" }), now);
  assert.equal(hasAccess(state), false);
  assert.equal(canCancel(state), true);
});

test("ended statuses", () => {
  for (const status of ["canceled", "incomplete_expired"]) {
    assert.equal(subscriptionState(sub({ status }), now), "ended");
  }
});

test("a trial is offered time whatever the reason, never money", () => {
  for (const reason of ["too_expensive", "no_time", "switched"] as const) {
    assert.deepEqual(pickOffer({ state: "trialing", reason, offerUsed: false }), { kind: "extend_trial", days: 7 });
  }
});

test("a paying customer gets what the reason asks for", () => {
  assert.equal(pickOffer({ state: "active", reason: "pausing", offerUsed: false })?.kind, "pause");
  assert.deepEqual(pickOffer({ state: "active", reason: "too_expensive", offerUsed: false }), {
    kind: "discount",
    percentOff: 50,
    months: 2,
  });
  assert.deepEqual(pickOffer({ state: "active", reason: "no_results", offerUsed: false }), {
    kind: "discount",
    percentOff: 100,
    months: 1,
  });
});

test("one offer per customer, and none while paused", () => {
  assert.equal(pickOffer({ state: "active", reason: "no_results", offerUsed: true }), null);
  assert.equal(pickOffer({ state: "paused", reason: "pausing", offerUsed: false }), null);
});

test("a trial extension adds to what is left but never passes the total cap", () => {
  const start = t - 3 * DAY;
  // 7-day trial, 4 days left: +7 would be day 14, exactly the cap.
  assert.equal(extendedTrialEnd({ trial_start: start, trial_end: start + 7 * DAY }, 7, 14, now), start + 14 * DAY);
  // Already extended to day 12: +7 is clipped to day 14.
  assert.equal(extendedTrialEnd({ trial_start: start, trial_end: start + 12 * DAY }, 7, 14, now), start + 14 * DAY);
  // Already at the cap: nothing changes, and it never moves backwards.
  assert.equal(extendedTrialEnd({ trial_start: start - 20 * DAY, trial_end: t + DAY }, 7, 14, now), t + DAY);
});

test("unpaid still owes money: no access, but it can always cancel", () => {
  const state = subscriptionState(sub({ status: "unpaid" }), now);
  assert.equal(state, "past_due");
  assert.equal(hasAccess(state), false);
  assert.equal(canCancel(state), true);
});

test("a failed renewal is offered this month forgiven, once", () => {
  assert.deepEqual(pickOffer({ state: "past_due", reason: "too_expensive", offerUsed: false }), {
    kind: "waive_invoice",
  });
  assert.equal(pickOffer({ state: "past_due", reason: "too_expensive", offerUsed: true }), null);
});

test("the refund window is inclusive at its edge and never in the future", () => {
  const paid = new Date(now.getTime() - 24 * 3_600_000);
  assert.equal(isWithinRefundWindow(paid, now, 24), true);
  assert.equal(isWithinRefundWindow(new Date(paid.getTime() - 1), now, 24), false);
  assert.equal(isWithinRefundWindow(new Date(now.getTime() + 60_000), now, 24), false);
});
