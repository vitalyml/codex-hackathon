import { v } from "convex/values";
import { query } from "./_generated/server";

/** The latest 50, oldest first. Takes a string for the same reason sessions:live does.
 * `callId` names the frame: the page that sent it still has it. */
export const list = query({
  args: { sessionId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("events"),
      at: v.number(),
      text: v.string(),
      rule: v.string(),
      callId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    if (!sessionId) return [];
    const latest = await ctx.db
      .query("events")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(50);
    return latest.reverse().map((e) => ({
      id: e._id,
      at: e._creationTime,
      text: e.text,
      rule: e.rule,
      callId: e.callId,
    }));
  },
});
