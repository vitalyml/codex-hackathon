import { v } from "convex/values";
import { query } from "./_generated/server";

/** The latest 50, oldest first. Takes a string for the same reason sessions:live does. */
export const list = query({
  args: { sessionId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("events"),
      at: v.number(),
      text: v.string(),
      rule: v.string(),
      url: v.union(v.string(), v.null()),
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
    return Promise.all(
      latest.reverse().map(async (e) => ({
        id: e._id,
        at: e._creationTime,
        text: e.text,
        rule: e.rule,
        url: await ctx.storage.getUrl(e.storageId),
      })),
    );
  },
});
