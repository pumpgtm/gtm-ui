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

An in-app cancel dialog: a reason, at most one save offer, then a real
cancellation.

- **Cancelling cancels here.** The subscription is set to end at the end of
  its trial or paid period through the Stripe API. Customers are never sent to
  the billing portal, where we saw cancellations fail to land.
- **The offer follows the reason.** A trial is offered more days, never money.
  A paying customer who is pausing is offered a pause, one who finds it too
  expensive gets a discount, and anyone else gets a free month.
- **One offer per subscription, ever**, and a trial can never run past 14 days
  in total.
- **"No thanks, cancel" is always on screen.**
- **Nothing to migrate.** The reason goes into Stripe's own
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
import { offerUsed } from "@/lib/cancel-subscription";

const subscription = await stripe.subscriptions.retrieve(subscriptionId);
const state = subscriptionState(subscription);

{canCancel(state) && (
  <CancelFlow
    state={state}
    offerUsed={offerUsed(subscription)}
    action={cancelAction}
    bookingUrl="https://cal.com/you" // optional: a call with a person, offered first
  />
)}
```

Change the offers by passing a `policy` (trial extension days, total trial
cap, discount, pause length) to both `CancelFlow` and `cancelSubscription`.

## subscription-state

One function that turns a Stripe subscription into the product decision, so
no gate compares `status` strings on its own:

`needs_card`, `trialing`, `trial_canceling`, `active`, `canceling`, `paused`,
`past_due`, `ended`, plus `hasAccess(state)` and `canCancel(state)`.

- A cancelled trial keeps access until it ends.
- No subscription, an unfinished checkout, or a trial that ended without a
  card all mean `needs_card`, not "unavailable".
- `past_due` can always cancel.

## Developing

```bash
pnpm install
pnpm test     # the rules
pnpm build    # writes public/r/*.json
```

MIT licensed. Built and maintained by [PumpGTM](https://pumpgtm.com).
