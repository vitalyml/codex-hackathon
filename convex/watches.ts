import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  MutationCtx,
  action,
  internalMutation,
  mutation,
} from "./_generated/server";
import {
  Failure,
  MAX_WATCHES,
  Usage,
  addUsage,
  direction,
  failure,
  normalize,
  usageValidator,
} from "./lib";

export const watchSpec = v.object({
  rule: v.string(),
  predicate: v.string(),
  direction,
});

const tooMany = {
  error: "too_many_rules",
  hint: `at most ${MAX_WATCHES} rules per camera`,
};

/** Bill the normalize call and append the watch, in one transaction; the others keep
 * their state. Without `watch` it only bills: a rejected rule still cost a model call.
 * Shared with the worker tier (Telegram normalizes in Python, then inserts). */
export async function insertWatch(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  usage: Usage,
  watch?: typeof watchSpec.type,
): Promise<null | Failure> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.status !== "active") return { error: "no_session" };
  await ctx.db.patch(sessionId, { usage: addUsage(session.usage, usage) });
  if (!watch) return null;
  const watches = await ctx.db
    .query("watches")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  if (watches.length >= MAX_WATCHES) return tooMany;
  await ctx.db.insert("watches", {
    sessionId,
    order: (watches.at(-1)?.order ?? -1) + 1,
    ...watch,
    state: null,
    evidence: "",
  });
  return null;
}

/** Add one rule to a running session. */
export const add = action({
  args: { sessionId: v.id("sessions"), rule: v.string() },
  returns: v.union(v.null(), failure),
  handler: async (ctx, args): Promise<null | Failure> => {
    const rule = args.rule.trim();
    if (!rule)
      return { error: "empty_rule", hint: "describe something that happens" };
    const specs = await normalize([rule]);
    if ("error" in specs) return specs;
    const [spec] = specs;
    return await ctx.runMutation(internal.watches.insert, {
      sessionId: args.sessionId,
      usage: spec.usage,
      watch: { rule, predicate: spec.predicate, direction: spec.direction },
    });
  },
});

export const insert = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    usage: usageValidator,
    watch: v.optional(watchSpec),
  },
  returns: v.union(v.null(), failure),
  handler: (ctx, args) =>
    insertWatch(ctx, args.sessionId, args.usage, args.watch),
});

export const remove = mutation({
  args: { watchId: v.id("watches") },
  returns: v.union(v.null(), failure),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return null; // already gone: a double click
    const watches = await ctx.db
      .query("watches")
      .withIndex("by_session", (q) => q.eq("sessionId", watch.sessionId))
      .collect();
    // Never below one rule: a session with nothing to watch has no reason to exist.
    if (watches.length === 1)
      return { error: "last_rule", hint: "keep at least one rule, or stop" };
    await ctx.db.delete(watchId);
    return null;
  },
});
