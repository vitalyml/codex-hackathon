import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  MutationCtx,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { workerUrl } from "./lib";

const BATCH = 500; // events deleted per cleanup run

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

/** A stop is final: the session goes `stopped` and its deletion is scheduled at once.
 * What the model saw is the user's camera and lives only as long as the session. */
export async function stopSession(ctx: MutationCtx, sessionId: Id<"sessions">) {
  await ctx.db.patch(sessionId, { status: "stopped" });
  await ctx.scheduler.runAfter(0, internal.crons.cleanup, { resume: sessionId });
}

/** Deletes stopped sessions with their events, one session at a time. One bounded batch
 * per run, then it schedules itself: a session with thousands of events must not hit the
 * transaction limits. A session once started is finished (`resume`). Scheduled by
 * `stopSession`; the hourly cron catches anything that schedule missed. */
export const cleanup = internalMutation({
  args: { resume: v.optional(v.id("sessions")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    let session = args.resume ? await ctx.db.get(args.resume) : null;
    if (!session) {
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
    for (const event of events) await ctx.db.delete(event._id);
    const done = events.length < BATCH;
    if (done) {
      for (const table of ["watches", "presence"] as const)
        for (const row of await owned(table).collect())
          await ctx.db.delete(row._id);
      await ctx.db.delete(sessionId);
    }
    await ctx.scheduler.runAfter(0, internal.crons.cleanup, {
      resume: done ? undefined : sessionId,
    });
    return null;
  },
});

const crons = cronJobs();
crons.interval("stop stale sessions", { minutes: 1 }, internal.presence.sweep, {});
crons.interval("keep the worker awake", { minutes: 10 }, internal.crons.keepAlive, {});
crons.interval("delete stopped sessions", { hours: 1 }, internal.crons.cleanup, {});
export default crons;
