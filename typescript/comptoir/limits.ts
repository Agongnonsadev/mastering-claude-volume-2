// The Comptoir's limits on the web (chapter 18): who sends, how much, and what size.
//
// The budget of chapter 8 counts per conversation: a script that opens a new conversation at each message
// never sees it come back. Hence three limits per network address, in front of the budget:
// - messages per minute: a burst stops;
// - new conversations per hour: getting around the customer quota stops;
// - a quota in dollars per day (comptoir/budget.ts, group): an address never takes the whole day.
//
// An address is not a person: behind that of a mobile operator, there are often many subscribers. The
// limits are generous, made for a script; the solid identity will come from the phone number, with
// WhatsApp (chapter 19).
//
// The counters live in memory: a restart resets them to zero, which is acceptable to stop a burst. The
// quota in dollars, for its part, is in the budget's database.

import { performance } from "node:perf_hooks";

/** A sliding window per key: at most `maximum` events during `windowS` seconds. */
export class RateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    readonly maximum: number,
    readonly windowS: number,
    private readonly clock: () => number = () => performance.now() / 1000,
  ) {}

  /** null if the event is accepted (and counted); otherwise, the number of seconds to wait. */
  accept(key: string): number | null {
    const now = this.clock();
    const queue = this.events.get(key) ?? [];
    while (queue.length && queue[0]! <= now - this.windowS) queue.shift();
    this.events.set(key, queue);
    if (queue.length >= this.maximum) return Math.round((queue[0]! + this.windowS - now) * 10) / 10;
    queue.push(now);
    return null;
  }
}

/**
 * The customer's address. Behind a trusted proxy (Caddy), it is the last address this proxy added to
 * X-Forwarded-For; without a trusted proxy, the header is ignored: anyone can write it.
 */
export function clientAddress(host: string | null | undefined, forwardedFor: string | null | undefined, trustedProxies: string[]): string {
  if (host && trustedProxies.includes(host) && forwardedFor) return forwardedFor.split(",").at(-1)!.trim();
  return host || "unknown";
}
