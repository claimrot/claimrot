import type { Claim, Verdict } from "../model/types.js";

const DAY = 86_400_000;
const plus = (now: Date, d: number) => new Date(now.getTime() + d * DAY);

export function nextCheckAt(
  claim: Claim, lastVerdict: Verdict | null, consecutiveUnverifiable: number, now: Date,
): Date {
  if (lastVerdict === "UNVERIFIABLE") {
    const backoff = Math.min(30, 3 ** Math.max(0, consecutiveUnverifiable - 1));
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

  return plus(now, claim.volatile ? 7 : 90);
}
