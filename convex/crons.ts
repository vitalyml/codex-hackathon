import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { workerUrl } from "./lib";

const HACKATHON_END = Date.UTC(2026, 8, 25, 12); // 2026-09-25 12:00 UTC
const BATCH = 500; // events deleted per cleanup run
const MAX_EVENTS = 5000; // about half of the 1 GB file quota at 50-100 KB a photo

/** The free Render plan spins down after 15 minutes without inbound traffic and takes
 * about a minute to wake. */
export const keepAlive = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    if (!workerUrl()) return null;
    try {
      const res = await fetch(`${workerUrl()}/health`);
      if (!res.ok) console.warn(`worker /health: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`worker /health: ${e}`);
    }
    return null;
  },
});

/** Stopped sessions are kept until the hackathon ends, unless photos eat the quota:
 * then the oldest go first, one at a time, until the count is back under the limit.
 * One bounded batch per run, then it schedules itself: a session with thousands of
 * events must not hit the transaction limits. A session once started is finished
 * (`resume`) even if the count drops under the limit halfway: events of one frame share
 * a photo, and a half-deleted session would keep events without theirs.
 * `now` is for testing. */
export const cleanup = internalMutation({
  args: { now: v.optional(v.number()), resume: v.optional(v.id("sessions")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    let session = args.resume ? await ctx.db.get(args.resume) : null;
    if (!session) {
      const over =
        (await ctx.db.query("events").take(MAX_EVENTS + 1)).length > MAX_EVENTS;
      if ((args.now ?? Date.now()) < HACKATHON_END && !over) return null;
      session = await ctx.db
        .query("sessions")
        .withIndex("by_status", (q) => q.eq("status", "stopped"))
        .first();
      if (!session) return null;
    }
    const sessionId = session._id;
    const owned = (table: "events" | "watches" | "presence") =>
      ctx.db
        .query(table)
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId));
    const events = await owned("events").take(BATCH);
    for (const event of events) {
      // Events of one frame share a photo: it may be gone already.
      if (await ctx.db.system.get(event.storageId))
        await ctx.storage.delete(event.storageId);
      await ctx.db.delete(event._id);
    }
    const done = events.length < BATCH;
    if (done) {
      for (const table of ["watches", "presence"] as const)
        for (const row of await owned(table).collect())
          await ctx.db.delete(row._id);
      await ctx.db.delete(sessionId);
    }
    await ctx.scheduler.runAfter(0, internal.crons.cleanup, {
      now: args.now,
      resume: done ? undefined : sessionId,
    });
    return null;
  },
});

const crons = cronJobs();
crons.interval("stop stale sessions", { minutes: 1 }, internal.presence.sweep, {});
crons.interval("keep the worker awake", { minutes: 10 }, internal.crons.keepAlive, {});
crons.interval("delete old sessions", { hours: 1 }, internal.crons.cleanup, {});
export default crons;
