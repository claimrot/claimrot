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

  // A claim that announces its own death gets checked the day before it dies.
  if (claim.expiresAt) {
    const expiry = new Date(claim.expiresAt);
    const eve = new Date(expiry.getTime() - DAY);
    if (eve > now) return eve;
  }

  return plus(now, claim.volatile ? 7 : 90);
}
