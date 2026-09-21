import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { FREE_MS, MAX_SUBSCRIBERS } from "./lib";

/** A browser asks for a notification channel on first load. Outlives its sessions. */
export const create = mutation({
  args: {},
  returns: v.id("subscribers"),
  handler: async (ctx) => {
    // Evict the stalest instead of refusing: subscribing costs nothing and a new
    // browser must always get a QR, unlike a session which holds a model budget.
    // ponytail: full scan - this eviction is what caps the table at MAX_SUBSCRIBERS
    const all = await ctx.db.query("subscribers").collect();
    all.sort((a, b) => a.lastSeen - b.lastSeen);
    const excess = Math.max(0, all.length - MAX_SUBSCRIBERS + 1);
    // Never the one behind a running session: its alerts and its limit hang on this row,
    // and nothing refreshes lastSeen while it runs. At most MAX_SESSIONS are spared.
    const active = await ctx.db
      .query("sessions")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    const busy = new Set(active.map((s) => s.subscriberId));
    for (const stale of all.filter((s) => !busy.has(s._id)).slice(0, excess))
      await ctx.db.delete(stale._id);
    return await ctx.db.insert("subscribers", {
      muted: false,
      lastSeen: Date.now(),
    });
  },
});

/** null: evicted or garbage - the page makes a new one. Never exposes the chat id. */
export const get = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({ linked: v.boolean(), limitAt: v.number() }),
  ),
  handler: async (ctx, { token }) => {
    const id = ctx.db.normalizeId("subscribers", token);
    const subscriber = id && (await ctx.db.get(id));
    if (!subscriber) return null;
    return {
      linked: subscriber.chatId !== undefined,
      limitAt: subscriber._creationTime + FREE_MS,
    };
  },
});
