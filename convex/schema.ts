import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    status: v.union(v.literal("active"), v.literal("stopped")),
    subscriberId: v.optional(v.id("subscribers")),
    lastCallId: v.optional(v.string()), // the last model answer recorded: see worker:record
    // Tokens spent by this session; usdTicks is an estimate, 1 tick = 1e-10 USD.
    usage: v.object({
      prompt: v.number(),
      completion: v.number(),
      calls: v.number(),
      usdTicks: v.number(),
    }),
  })
    .index("by_status", ["status"])
    .index("by_subscriber", ["subscriberId", "status"]),

  // Heartbeats live apart from sessions so they do not invalidate sessions:live.
  presence: defineTable({
    sessionId: v.id("sessions"),
    lastSeen: v.number(),
  }).index("by_session", ["sessionId"]),

  watches: defineTable({
    sessionId: v.id("sessions"),
    order: v.number(),
    rule: v.string(), // the user's words
    predicate: v.string(),
    direction: v.union(v.literal("rising"), v.literal("falling")),
    state: v.union(v.boolean(), v.null()), // confirmed tracker state; null until the first answer
    evidence: v.string(),
  }).index("by_session", ["sessionId", "order"]),

  events: defineTable({
    sessionId: v.id("sessions"),
    watchId: v.id("watches"),
    text: v.string(),
    rule: v.string(),
    storageId: v.id("_storage"),
  }).index("by_session", ["sessionId"]),

  // A browser that may ask for Telegram alerts. Its id is the token the page keeps.
  subscribers: defineTable({
    chatId: v.optional(v.number()), // Telegram chat bound via /start <token>
    muted: v.boolean(),
    lastSeen: v.number(),
  }).index("by_chat", ["chatId"]),
});
