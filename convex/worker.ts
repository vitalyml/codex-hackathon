/** What only the Python worker may call. Every function checks the shared secret first.
 * To read a session the worker uses the public sessions:live - it has the watches with
 * their tracker state, the status and limitAt, and needs no secret. */
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { addUsage, checkSecret, usageValidator } from "./lib";

/** Where to POST an event photo; the response carries the storageId for `record`. */
export const uploadUrl = mutation({
  args: { secret: v.string() },
  returns: v.string(),
  handler: async (ctx, { secret }) => {
    checkSecret(secret);
    return await ctx.storage.generateUploadUrl();
  },
});

/** One model call answered: bill it, store each watch's new tracker state and evidence,
 * and the events that fired. Returns the Telegram chat to alert, if any. */
export const record = mutation({
  args: {
    secret: v.string(),
    sessionId: v.id("sessions"),
    usage: usageValidator,
    results: v.array(
      v.object({
        watchId: v.id("watches"),
        state: v.boolean(),
        evidence: v.string(),
        event: v.optional(
          v.object({ text: v.string(), storageId: v.id("_storage") }),
        ),
      }),
    ),
  },
  returns: v.object({ chatId: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    checkSecret(args.secret);
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { chatId: null };
    // Billed even if the session stopped meanwhile: the call was made.
    await ctx.db.patch(session._id, {
      usage: addUsage(session.usage, args.usage),
    });
    // Rules that fire on the same frame share one photo, so a photo goes only when no
    // event kept it.
    const kept = new Set<string>();
    const uploaded = new Set(args.results.flatMap((r) => r.event?.storageId ?? []));
    for (const r of args.results) {
      const watch = await ctx.db.get(r.watchId);
      // Dropped or edited (an edit gives the watch a new id) while the model was
      // thinking, or the session stopped: the answer is for nothing that exists.
      if (!watch || session.status !== "active") continue;
      await ctx.db.patch(watch._id, { state: r.state, evidence: r.evidence });
      if (!r.event) continue;
      await ctx.db.insert("events", {
        sessionId: session._id,
        watchId: watch._id,
        rule: watch.rule,
        ...r.event,
      });
      kept.add(r.event.storageId);
    }
    for (const id of uploaded) if (!kept.has(id)) await ctx.storage.delete(id);
    const fired = kept.size > 0;
    const subscriber =
      fired && session.subscriberId
        ? await ctx.db.get(session.subscriberId)
        : null;
    return {
      chatId: subscriber && !subscriber.muted ? (subscriber.chatId ?? null) : null,
    };
  },
});
