<p align="center">
  <a href="https://pumpgtm.com"><strong>PumpGTM finds buyers who need your product now and runs your LinkedIn outreach →</strong></a>
</p>

# @gtm

Billing and growth components for shadcn/ui, from [PumpGTM](https://pumpgtm.com).
Each one encodes a rule we learned the hard way running trials and
subscriptions on Stripe for [PumpGTM](https://pumpgtm.com).

```bash
npx shadcn@latest add @gtm/cancel-flow
```

Works with both the Radix and the Base UI flavours of shadcn/ui.

## cancel-flow

An in-app cancel dialog: a reason, one next step, then a real cancellation.

- **Cancelling cancels here.** The subscription ends at the end of its trial or
  paid period through the Stripe API. Customers are never sent to the billing
  portal, where we saw cancellations fail to land.
- **Charged in the last 24 hours? Refund it.** Instead of a save offer, the
  customer sees the charge and one button that refunds it in full and ends the
  subscription now. The server rechecks the charge with Stripe, and a double
  submit is still one refund.
- **The offer follows the reason.** A trial is offered more days, never money.
  A paying customer who is pausing is offered a pause, one who finds it too
  expensive gets a discount, and anyone else gets a free month.
- **A failed payment is forgiven, not discounted.** A past-due customer's offer
  voids the failed invoice, so this month is free; a coupon would only discount
  next month and leave this one owed. Cancelling past due ends the
  subscription now and voids what it owes, so the card stops being retried.
- **One follow-up question** after "too expensive" (what would you pay),
  "switching" (to what) and "missing a feature" (which one).
- **One offer per customer, ever**, and a trial can never run past 14 days in
  total. A free month that was accepted and never used carries over to a
  restarted subscription (`unusedFreeMonthCoupon`).
- **"No thanks, cancel" is always on screen**, and "Keep my subscription"
  (`resumeSubscription`) undoes a scheduled cancellation, including one made in
  the Stripe portal.
- **Nothing to migrate.** The reason and follow-up answer go into Stripe's own
  `cancellation_details`, and the offer shown, and what the customer did with
  it, into the subscription's metadata.

```tsx
// app/billing/actions.ts
"use server";
import Stripe from "stripe";
import { cancelSubscription, type CancelRequest } from "@/lib/cancel-subscription";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function cancelAction(request: CancelRequest) {
  const subscriptionId = await currentUserSubscriptionId(); // yours: never from the browser
  return cancelSubscription(stripe, subscriptionId, request);
}
```

```tsx
// app/billing/page.tsx
import { CancelFlow } from "@/components/cancel-flow";
import { subscriptionState, canCancel } from "@/lib/subscription-state";
import { offerUsed, refundableCharge } from "@/lib/cancel-subscription";

const subscription = await stripe.subscriptions.retrieve(subscriptionId);
const state = subscriptionState(subscription);

{canCancel(state) && (
  <CancelFlow
    state={state}
    offerUsed={await offerUsed(stripe, subscription.customer as string)}
    refund={await refundableCharge(stripe, subscriptionId)}
    action={cancelAction}
    bookingUrl="https://cal.com/you" // optional: a call with a person, offered first
  />
)}
```

Change the offers by passing a `policy` (trial extension days, total trial
cap, discount, pause length, refund window) to `CancelFlow`,
`cancelSubscription` and `refundableCharge`.

## subscription-state

One function that turns a Stripe subscription into the product decision, so
no gate compares `status` strings on its own:

`needs_card`, `trialing`, `trial_canceling`, `active`, `canceling`, `paused`,
`past_due`, `ended`, plus `hasAccess(state)` and `canCancel(state)`.

- A cancelled trial keeps access until it ends.
- No subscription, an unfinished checkout, or a trial that ended without a
  card all mean `needs_card`, not "unavailable".
- `past_due` (and Stripe's `unpaid`) has no access but can always cancel.

## Developing

```bash
pnpm install
pnpm test     # the rules
pnpm build    # writes public/r/*.json
```

MIT licensed. Built and maintained by [PumpGTM](https://pumpgtm.com).
