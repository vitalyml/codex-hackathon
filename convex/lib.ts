import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";

export const MAX_SESSIONS = 10; // active at once: each one holds a model budget
export const MAX_WATCHES = 5; // rules per session
export const MAX_SUBSCRIBERS = 100;
export const FREE_MS = 10 * 60 * 1000; // free use, counted from the subscriber's creation
// Background tabs throttle timers to about once a minute, so anything shorter kills them.
export const STALE_MS = 180 * 1000;

export const usageValidator = v.object({
  prompt: v.number(),
  completion: v.number(),
  calls: v.number(),
  usdTicks: v.number(),
});

export type Usage = typeof usageValidator.type;

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    calls: a.calls + b.calls,
    usdTicks: a.usdTicks + b.usdTicks,
  };
}

/** Convex functions cannot read request headers, so worker-tier functions take the
 * shared secret as an argument and check it before anything else. */
export function checkSecret(secret: string): void {
  const expected = process.env.WORKER_SECRET;
  if (!expected || secret !== expected) throw new Error("forbidden");
}

/** When free use ends. A timestamp, not a boolean: query results are cached, so the
 * caller compares it with its own clock. Stop -> Start keeps the subscriber, so it does
 * not reset the limit. */
export async function limitAt(
  ctx: QueryCtx,
  session: Doc<"sessions">,
): Promise<number> {
  const subscriber = session.subscriberId
    ? await ctx.db.get(session.subscriberId)
    : null;
  return (subscriber ?? session)._creationTime + FREE_MS;
}

export type Spec = {
  predicate: string;
  direction: "rising" | "falling";
  isTransition: boolean;
  usage: Usage;
};

export type Failure = { error: string; hint?: string };

/** Rule normalization stays in Python: ask the worker. On the free Render plan it may be
 * asleep and takes about a minute to wake, so that is reported, not waited out. */
export async function normalize(rules: string[]): Promise<Spec[] | Failure> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const res = await fetch(`${process.env.WORKER_URL}/internal/normalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.WORKER_SECRET}`,
      },
      body: JSON.stringify({ rules }),
      signal: abort.signal,
    });
    const body = await res.json();
    if (!res.ok) return { error: body.error ?? "perception", hint: body.hint };
    return body.specs;
  } catch {
    return { error: "worker_starting", hint: "the worker is waking up - try again in a minute" };
  } finally {
    clearTimeout(timer);
  }
}
