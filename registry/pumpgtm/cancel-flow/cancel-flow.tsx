"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { SubscriptionState } from "@/lib/subscription-state";
import {
  PAID_REASONS,
  TRIAL_REASONS,
  describeOffer,
  pickOffer,
  type CancelReason,
  type OfferPolicy,
  type SaveOffer,
} from "@/lib/cancel-offer";
import type { CancelRequest, CancelResult } from "@/lib/cancel-subscription";

// Reason, then at most one save offer, then the cancellation. Every offer
// screen has the same moves in the same order: talk to a person, take the
// offer, or cancel. "No thanks, cancel" is always visible and never a trick.

export interface CancelFlowProps {
  state: SubscriptionState;
  // True once this subscription has accepted a save offer (see `offerUsed`).
  offerUsed: boolean;
  // Your server action: authenticate, look up the user's subscription id, then
  // return `cancelSubscription(stripe, subscriptionId, request)`.
  action: (request: CancelRequest) => Promise<CancelResult>;
  policy?: OfferPolicy;
  // A booking link for a call with a real person, offered first.
  bookingUrl?: string;
  // Shown above the offer, for example a short founder video.
  media?: ReactNode;
  triggerLabel?: string;
  onDone?: (result: CancelResult) => void;
}

export function CancelFlow({
  state,
  offerUsed,
  action,
  policy,
  bookingUrl,
  media,
  triggerLabel,
  onDone,
}: CancelFlowProps) {
  const isTrial = state === "trialing";
  const noun = isTrial ? "trial" : "subscription";
  const reasons: Record<string, string> = isTrial ? TRIAL_REASONS : PAID_REASONS;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"reason" | "offer" | "done">("reason");
  const [reason, setReason] = useState<CancelReason | null>(null);
  const [comment, setComment] = useState("");
  const [result, setResult] = useState<CancelResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const offer = reason ? pickOffer({ state, reason, offerUsed, policy }) : null;
  // Whether an offer step follows, known before a reason is picked so the
  // button does not change its label under the customer's cursor.
  const offerFollows = pickOffer({ state, reason: reason ?? "other", offerUsed, policy }) != null;

  function openChange(next: boolean) {
    setOpen(next);
    if (next) return;
    if (result) onDone?.(result);
    setStep("reason");
    setReason(null);
    setComment("");
    setResult(null);
    setError(null);
  }

  function submit(decision: CancelRequest["decision"]) {
    if (!reason) return;
    setError(null);
    startTransition(async () => {
      try {
        const next = await action({ reason, comment, decision });
        if (next.outcome === "invalid") {
          setError("This subscription can't be changed right now. Refresh the page and try again.");
          return;
        }
        setResult(next);
        setStep("done");
      } catch {
        setError("Something went wrong and nothing was changed. Please try again.");
      }
    });
  }

  return (
    // No asChild or render props anywhere, so the same file works with the
    // Radix and the Base UI flavours of the shadcn primitives.
    <Dialog open={open} onOpenChange={openChange}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {triggerLabel ?? `Cancel ${noun}`}
      </Button>
      <DialogContent className="sm:max-w-lg">
        {step === "reason" && (
          <>
            <DialogHeader>
              <DialogTitle>Before you go, what&apos;s the main reason?</DialogTitle>
              <DialogDescription>One answer is enough.</DialogDescription>
            </DialogHeader>
            <RadioGroup
              value={reason ?? ""}
              onValueChange={(value: unknown) => setReason(value as CancelReason)}
              className="grid gap-2 sm:grid-cols-2"
            >
              {Object.entries(reasons).map(([value, label]) => (
                <Label
                  key={value}
                  htmlFor={`cancel-reason-${value}`}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 font-normal has-[[aria-checked=true]]:border-primary has-[[aria-checked=true]]:bg-accent"
                >
                  <RadioGroupItem id={`cancel-reason-${value}`} value={value} />
                  {label}
                </Label>
              ))}
            </RadioGroup>
            <div className="grid gap-1.5">
              <Label htmlFor="cancel-comment" className="text-muted-foreground font-normal">
                {reason === "switched"
                  ? "Which one, and what does it do better? (optional)"
                  : "What would have changed your mind? (optional)"}
              </Label>
              <Textarea
                id="cancel-comment"
                maxLength={500}
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={() => openChange(false)}>
                Keep my {noun}
              </Button>
              {offerFollows ? (
                <Button disabled={!reason} onClick={() => setStep("offer")}>
                  Continue
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  disabled={!reason || pending}
                  onClick={() => submit("cancel")}
                >
                  Cancel my {noun}
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {step === "offer" && offer && (
          <>
            <DialogHeader>
              <DialogTitle>{bookingUrl ? "Can we talk first?" : "Before you cancel"}</DialogTitle>
              <DialogDescription>{offerPitch(offer, Boolean(bookingUrl))}</DialogDescription>
            </DialogHeader>
            {media}
            <div className="flex flex-col gap-2 sm:flex-row">
              {bookingUrl && (
                <a href={bookingUrl} target="_blank" rel="noreferrer" className={buttonVariants()}>
                  Book a call
                </a>
              )}
              <Button
                variant={bookingUrl ? "outline" : "default"}
                disabled={pending}
                onClick={() => submit("accept_offer")}
              >
                {describeOffer(offer)}
              </Button>
            </div>
            {error && <p className="text-destructive text-sm">{error}</p>}
            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" disabled={pending} onClick={() => submit("cancel")}>
                No thanks, cancel my {noun}
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setStep("reason")}>
                Back
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "done" && result && (
          <>
            <DialogHeader>
              <DialogTitle>{result.outcome === "saved" ? "Done, thank you for staying" : `Your ${noun} is cancelled`}</DialogTitle>
              <DialogDescription>{doneMessage(result, noun)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => openChange(false)}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function offerPitch(offer: SaveOffer, canCall: boolean): string {
  const call = canCall ? "A short call is the fastest way to fix what went wrong. Or: " : "";
  switch (offer.kind) {
    case "extend_trial":
      return `${call}take ${offer.days} more days, free. A short trial is rarely long enough to judge it.`;
    case "pause":
      return `${call}pause billing for ${offer.months === 1 ? "a month" : `${offer.months} months`}. Your account stays exactly as it is and picks up again on its own.`;
    case "discount":
      return offer.percentOff === 100
        ? `${call}take your next ${offer.months === 1 ? "month" : `${offer.months} months`} free, on us.`
        : `${call}take ${offer.percentOff}% off your next ${offer.months} months.`;
  }
}

function doneMessage(result: CancelResult, noun: string): string {
  if (result.outcome === "saved") {
    return result.offer.kind === "pause"
      ? "Billing is paused. Nothing else changes."
      : "The offer is applied to your account.";
  }
  if (result.outcome === "cancelled" && result.accessEndsAt) {
    const date = result.accessEndsAt.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return result.accessEndsAt.getTime() <= Date.now() + 60_000
      ? `Your ${noun} has ended. You won't be charged again.`
      : `You keep full access until ${date}. You won't be charged again.`;
  }
  return "You won't be charged again.";
}
