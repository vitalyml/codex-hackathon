import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { stopSession } from "./crons";
import { STALE_MS } from "./lib";

/** The page calls this every 20 s, also while paused and sending no frames. */
export const heartbeat = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session || session.status !== "active") return null; // never revives a stopped one
    const row = await ctx.db
      .query("presence")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (row) await ctx.db.patch(row._id, { lastSeen: Date.now() });
    return null;
  },
});

/** Cron: a session whose page went away is stopped, and that is final. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const active = await ctx.db
      .query("sessions")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    for (const session of active) {
      const row = await ctx.db
        .query("presence")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .unique();
      if (!row || Date.now() - row.lastSeen > STALE_MS)
        await stopSession(ctx, session._id);
    }
    return null;
  },
});
