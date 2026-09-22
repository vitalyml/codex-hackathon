import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  freeUntil,
  Failure,
  MAX_SESSIONS,
  MAX_WATCHES,
  addUsage,
  direction,
  failure,
  limitAt,
  normalize,
  usageValidator,
} from "./lib";

/** Normalize the rules on the worker, then create the session in one mutation. */
export const start = action({
  args: { rules: v.array(v.string()), subscriber: v.optional(v.string()) },
  returns: v.union(v.object({ sessionId: v.id("sessions") }), failure),
  handler: async (ctx, args): Promise<{ sessionId: Id<"sessions"> } | Failure> => {
    const rules = args.rules.map((r) => r.trim()).filter(Boolean);
    if (!rules.length)
      return { error: "empty_rule", hint: "describe something that happens" };
    if (rules.length > MAX_WATCHES)
      return {
        error: "too_many_rules",
        hint: `at most ${MAX_WATCHES} rules per camera`,
      };
    const specs = await normalize(rules);
    if ("error" in specs) return specs;
    const vague = specs.findIndex((s) => !s.isTransition);
    if (vague >= 0)
      return {
        error: "not_a_transition",
        hint: `'${rules[vague]}': describe something that happens - e.g. 'the cat jumps onto the table'`,
      };
    return await ctx.runMutation(internal.sessions.create, {
      watches: specs.map((s, i) => ({
        rule: rules[i],
        predicate: s.predicate,
        direction: s.direction,
      })),
      // the normalize calls are billed to this session
      usage: specs.map((s) => s.usage).reduce(addUsage),
      subscriber: args.subscriber,
    });
  },
});

export const create = internalMutation({
  args: {
    watches: v.array(
      v.object({ rule: v.string(), predicate: v.string(), direction }),
    ),
    usage: usageValidator,
    subscriber: v.optional(v.string()),
  },
  returns: v.union(v.object({ sessionId: v.id("sessions") }), failure),
  handler: async (ctx, args) => {
    // Checked here, inside the transaction: two starts cannot both take the last slot.
    const active = await ctx.db
      .query("sessions")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    if (active.length >= MAX_SESSIONS) return { error: "full" };
    // A string, not an id: it comes from localStorage and may be stale or garbage.
    const subscriberId =
      args.subscriber && ctx.db.normalizeId("subscribers", args.subscriber);
    const subscriber = subscriberId ? await ctx.db.get(subscriberId) : null;
    if (subscriber && Date.now() > freeUntil(subscriber))
      return { error: "limit", hint: "free use is over" };
    const sessionId = await ctx.db.insert("sessions", {
      status: "active",
      subscriberId: subscriber?._id,
      usage: args.usage,
    });
    await ctx.db.insert("presence", { sessionId, lastSeen: Date.now() });
    for (const [order, w] of args.watches.entries())
      await ctx.db.insert("watches", {
        sessionId,
        order,
        ...w,
        state: null,
        evidence: "",
      });
    if (subscriber) await ctx.db.patch(subscriber._id, { lastSeen: Date.now() });
    return { sessionId };
  },
});

/** Everything the page shows about a running session except the event list. Takes a
 * string, not an id: it comes from the URL and localStorage and may be garbage. */
export const live = query({
  args: { sessionId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("active"), v.literal("stopped")),
      watches: v.array(
        v.object({
          id: v.id("watches"),
          rule: v.string(),
          predicate: v.string(),
          direction,
          state: v.union(v.boolean(), v.null()),
          evidence: v.string(),
        }),
      ),
      usage: usageValidator,
      startedAt: v.number(),
      limitAt: v.number(),
      telegram: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("sessions", args.sessionId);
    const session = id && (await ctx.db.get(id));
    if (!session) return null;
    const watches = await ctx.db
      .query("watches")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    const subscriber = session.subscriberId
      ? await ctx.db.get(session.subscriberId)
      : null;
    return {
      status: session.status,
      watches: watches.map((w) => ({
        id: w._id,
        rule: w.rule,
        predicate: w.predicate,
        direction: w.direction,
        state: w.state,
        evidence: w.evidence,
      })),
      usage: session.usage,
      startedAt: session._creationTime,
      limitAt: await limitAt(ctx, session),
      telegram: subscriber?.chatId !== undefined,
    };
  },
});

export const stop = mutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    if (await ctx.db.get(sessionId))
      await ctx.db.patch(sessionId, { status: "stopped" });
    return null;
  },
});
