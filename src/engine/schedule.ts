import type { Claim, Verdict } from "../model/types.js";

const DAY = 86_400_000;
const plus = (now: Date, d: number) => new Date(now.getTime() + d * DAY);

/** Ceiling on the exponential UNVERIFIABLE backoff, so a permanently-blind claim still gets rechecked monthly. */
const MAX_UNVERIFIABLE_BACKOFF_DAYS = 30;
/** Recheck cadence for a claim marked volatile in its fact pack. */
const VOLATILE_CHECK_INTERVAL_DAYS = 7;
/** Recheck cadence for an ordinary (non-volatile) claim. */
const STABLE_CHECK_INTERVAL_DAYS = 90;

export function nextCheckAt(
  claim: Claim, lastVerdict: Verdict | null, consecutiveUnverifiable: number, now: Date,
): Date {
  if (lastVerdict === "UNVERIFIABLE") {
    const backoff = Math.min(
      MAX_UNVERIFIABLE_BACKOFF_DAYS, 3 ** Math.max(0, consecutiveUnverifiable - 1),
    );
    return plus(now, backoff);
  }

  if (claim.expiresAt) {
    const expiry = new Date(claim.expiresAt);
    const eve = new Date(expiry.getTime() - DAY);
    const morningAfter = new Date(expiry.getTime() + DAY);
    // Before the change: confirm the old value still holds.
    if (eve > now) return eve;
    // After the change: catch the new one, rather than waiting out the cadence.
    if (morningAfter > now) return morningAfter;
    // Expiry is fully behind us — the claim is ordinary again.
  }

  return plus(now, claim.volatile ? VOLATILE_CHECK_INTERVAL_DAYS : STABLE_CHECK_INTERVAL_DAYS);
}
