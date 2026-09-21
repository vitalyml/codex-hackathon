/** What only the Python worker may call. Every function checks the shared secret first.
 * To read a session the worker uses the public sessions:live - it has the watches with
 * their tracker state, the status and limitAt, and needs no secret. */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  MAX_WATCHES,
  addUsage,
  checkSecret,
  failure,
  usageValidator,
} from "./lib";
import { insertWatch, watchSpec } from "./watches";

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
 * and the events that fired. Returns the watches whose events were kept - the only ones
 * worth an alert - and the Telegram chat to alert, if any. */
export const record = mutation({
  args: {
    secret: v.string(),
    sessionId: v.id("sessions"),
    // The worker retries a failed save with the same id, so an answer that was committed
    // but whose response got lost is not billed and recorded twice. One field is
    // enough: a session has one model call in flight at a time.
    callId: v.string(),
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
  returns: v.object({
    chatId: v.union(v.number(), v.null()),
    watchIds: v.array(v.id("watches")),
  }),
  handler: async (ctx, args) => {
    checkSecret(args.secret);
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { chatId: null, watchIds: [] };
    const repeated = session.lastCallId === args.callId;
    // Billed even if the session stopped meanwhile: the call was made.
    if (!repeated)
      await ctx.db.patch(session._id, {
        usage: addUsage(session.usage, args.usage),
        lastCallId: args.callId,
      });
    // Rules that fire on the same frame share one photo, so a photo goes only when no
    // event kept it.
    const kept = new Set<string>();
    const watchIds: Id<"watches">[] = [];
    const uploaded = new Set(args.results.flatMap((r) => r.event?.storageId ?? []));
    for (const r of repeated ? [] : args.results) {
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
      watchIds.push(watch._id);
    }
    if (!repeated)
      for (const id of uploaded) if (!kept.has(id)) await ctx.storage.delete(id);
    // A repeat still answers "what to alert about": the first response never arrived.
    // What it kept are the events carrying this call's photo, and they are the session's
    // latest: one call fires at most MAX_WATCHES and none has been recorded since.
    if (repeated) {
      const latest = await ctx.db
        .query("events")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(MAX_WATCHES);
      for (const e of latest)
        if (uploaded.has(e.storageId)) watchIds.push(e.watchId);
    }
    const subscriber =
      watchIds.length && session.subscriberId
        ? await ctx.db.get(session.subscriberId)
        : null;
    return {
      chatId: subscriber && !subscriber.muted ? (subscriber.chatId ?? null) : null,
      watchIds,
    };
  },
});

// Telegram. The bot runs in the worker; a chat is known by its numeric id only there
// and here, never on the page.

/** Everything one bot screen needs, in one read: null until the chat is linked. */
export const telegram = query({
  args: { secret: v.string(), chatId: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      muted: v.boolean(),
      session: v.union(
        v.null(),
        v.object({
          id: v.id("sessions"),
          watches: v.array(
            v.object({
              id: v.id("watches"),
              rule: v.string(),
              state: v.union(v.boolean(), v.null()),
              evidence: v.string(),
            }),
          ),
          eventCount: v.number(),
          // the latest five, newest first; n is the number the page shows
          events: v.array(
            v.object({
              id: v.id("events"),
              n: v.number(),
              at: v.number(),
              text: v.string(),
              rule: v.string(),
              url: v.union(v.string(), v.null()),
            }),
          ),
        }),
      ),
    }),
  ),
  handler: async (ctx, { secret, chatId }) => {
    checkSecret(secret);
    const subscriber = await ctx.db
      .query("subscribers")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .first();
    if (!subscriber) return null;
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_subscriber", (q) =>
        q.eq("subscriberId", subscriber._id).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (!session) return { muted: subscriber.muted, session: null };
    const watches = await ctx.db
      .query("watches")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    // ponytail: reads every event of the session to number them; a 10-minute session
    // has few. Keep a counter on the session if that stops being true.
    const events = await ctx.db
      .query("events")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .collect();
    return {
      muted: subscriber.muted,
      session: {
        id: session._id,
        watches: watches.map((w) => ({
          id: w._id,
          rule: w.rule,
          state: w.state,
          evidence: w.evidence,
        })),
        eventCount: events.length,
        events: await Promise.all(
          events
            .map((e, n) => ({ e, n }))
            .slice(-5)
            .reverse()
            .map(async ({ e, n }) => ({
              id: e._id,
              n,
              at: e._creationTime,
              text: e.text,
              rule: e.rule,
              url: await ctx.storage.getUrl(e.storageId),
            })),
        ),
      },
    };
  },
});

/** One saved event by id, for a button that may be older than the five on the screen.
 * null unless its session belongs to a browser bound to this chat. Takes a string: the id
 * comes back from a Telegram button. */
export const event = query({
  args: { secret: v.string(), chatId: v.number(), eventId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      at: v.number(),
      text: v.string(),
      rule: v.string(),
      url: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { secret, chatId, eventId }) => {
    checkSecret(secret);
    const id = ctx.db.normalizeId("events", eventId);
    const e = id && (await ctx.db.get(id));
    const session = e && (await ctx.db.get(e.sessionId));
    const subscriber =
      session?.subscriberId && (await ctx.db.get(session.subscriberId));
    if (!e || !subscriber || subscriber.chatId !== chatId) return null;
    return {
      at: e._creationTime,
      text: e.text,
      rule: e.rule,
      url: await ctx.storage.getUrl(e.storageId),
    };
  },
});

/** /start <token>: bind the chat to the browser behind the QR. false: no such browser.
 * A chat drives one camera, so whatever it was bound to before is released. */
export const link = mutation({
  args: { secret: v.string(), chatId: v.number(), token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { secret, chatId, token }) => {
    checkSecret(secret);
    const id = ctx.db.normalizeId("subscribers", token);
    if (!id || !(await ctx.db.get(id))) return false;
    const bound = await ctx.db
      .query("subscribers")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    for (const other of bound)
      if (other._id !== id) await ctx.db.patch(other._id, { chatId: undefined });
    await ctx.db.patch(id, { chatId });
    return true;
  },
});

/** Pause or resume alerts; the chat stays linked. */
export const mute = mutation({
  args: { secret: v.string(), chatId: v.number(), muted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { secret, chatId, muted }) => {
    checkSecret(secret);
    const bound = await ctx.db
      .query("subscribers")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    for (const s of bound) await ctx.db.patch(s._id, { muted });
    return null;
  },
});

export const unlink = mutation({
  args: { secret: v.string(), chatId: v.number() },
  returns: v.null(),
  handler: async (ctx, { secret, chatId }) => {
    checkSecret(secret);
    const bound = await ctx.db
      .query("subscribers")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();
    for (const s of bound) await ctx.db.patch(s._id, { chatId: undefined });
    return null;
  },
});

/** A rule typed in Telegram, already normalized by the worker. Without `watch` it only
 * bills. With `replaces` it is an edit: the new watch takes the old one's place and a
 * new id, so a model answer in flight for the old wording is ignored by `record`. */
export const putWatch = mutation({
  args: {
    secret: v.string(),
    sessionId: v.id("sessions"),
    usage: usageValidator,
    watch: v.optional(watchSpec),
    replaces: v.optional(v.id("watches")),
  },
  returns: v.union(v.null(), failure),
  handler: async (ctx, args) => {
    checkSecret(args.secret);
    if (!args.watch || !args.replaces)
      return insertWatch(ctx, args.sessionId, args.usage, args.watch);
    const failed = await insertWatch(ctx, args.sessionId, args.usage);
    if (failed) return failed;
    const old = await ctx.db.get(args.replaces);
    if (!old || old.sessionId !== args.sessionId) return { error: "no_watch" };
    await ctx.db.insert("watches", {
      sessionId: args.sessionId,
      order: old.order,
      ...args.watch,
      state: null,
      evidence: "",
    });
    await ctx.db.delete(old._id);
    return null;
  },
});
