import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

const HACKATHON_END = Date.UTC(2026, 8, 25, 12); // 2026-09-25 12:00 UTC
const MAX_EVENTS = 5000; // about half of the 1 GB file quota at 50-100 KB a photo

/** The free Render plan spins down after 15 minutes without inbound traffic and takes
 * about a minute to wake. */
export const keepAlive = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    if (!process.env.WORKER_URL) return null;
    try {
      const res = await fetch(`${process.env.WORKER_URL}/health`);
      if (!res.ok) console.warn(`worker /health: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`worker /health: ${e}`);
    }
    return null;
  },
});

/** Stopped sessions are kept until the hackathon ends, unless photos eat the quota:
 * then the oldest go first. `now` is for testing. */
export const cleanup = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const over =
      (await ctx.db.query("events").take(MAX_EVENTS + 1)).length > MAX_EVENTS;
    if ((args.now ?? Date.now()) < HACKATHON_END && !over) return 0;
    // ponytail: 10 sessions a run keeps the transaction small; the cron catches up hourly
    const doomed = await ctx.db
      .query("sessions")
      .withIndex("by_status", (q) => q.eq("status", "stopped"))
      .take(10);
    for (const session of doomed) {
      const owned = (table: "events" | "watches" | "presence") =>
        ctx.db
          .query(table)
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
      for (const event of await owned("events")) {
        await ctx.storage.delete(event.storageId);
        await ctx.db.delete(event._id);
      }
      for (const row of [...(await owned("watches")), ...(await owned("presence"))])
        await ctx.db.delete(row._id);
      await ctx.db.delete(session._id);
    }
    return doomed.length;
  },
});

const crons = cronJobs();
crons.interval("stop stale sessions", { minutes: 1 }, internal.presence.sweep, {});
crons.interval("keep the worker awake", { minutes: 10 }, internal.crons.keepAlive, {});
crons.interval("delete old sessions", { hours: 1 }, internal.crons.cleanup, {});
export default crons;
