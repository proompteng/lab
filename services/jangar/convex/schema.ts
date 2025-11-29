import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  conversations: defineTable({
    conversationId: v.string(),
    threadId: v.optional(v.string()),
    modelProvider: v.optional(v.string()),
    clientName: v.optional(v.string()),
    startedAt: v.number(),
    lastSeenAt: v.number(),
  }).index('byConversationId', ['conversationId']),

  turns: defineTable({
    turnId: v.string(),
    conversationId: v.string(),
    chatId: v.optional(v.string()),
    userId: v.optional(v.string()),
    model: v.optional(v.string()),
    serviceTier: v.optional(v.string()),
    status: v.string(), // running|succeeded|failed|canceled
    error: v.optional(v.string()),
    path: v.optional(v.string()),
    turnNumber: v.optional(v.number()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index('byConversation', ['conversationId'])
    .index('byChatId', ['chatId'])
    .index('byTurnId', ['turnId']),

  messages: defineTable({
    turnId: v.string(),
    role: v.string(), // user|assistant|system|tool
    content: v.string(),
    rawContent: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index('byTurn', ['turnId'])
    .index('byCreated', ['createdAt']),

  reasoning_sections: defineTable({
    turnId: v.string(),
    itemId: v.string(),
    summaryText: v.optional(v.array(v.string())),
    rawContent: v.optional(v.any()),
    position: v.optional(v.number()),
    createdAt: v.number(),
  }).index('byTurn', ['turnId']),

  commands: defineTable({
    callId: v.string(),
    turnId: v.string(),
    command: v.array(v.string()),
    cwd: v.optional(v.string()),
    source: v.optional(v.string()),
    parsedCmd: v.optional(v.any()),
    status: v.optional(v.string()), // started|completed|failed
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    aggregatedOutput: v.optional(v.string()),
    chunked: v.boolean(),
  })
    .index('byTurn', ['turnId'])
    .index('byCallId', ['callId']),

  command_chunks: defineTable({
    callId: v.string(),
    stream: v.string(), // stdout|stderr
    seq: v.number(),
    chunkBase64: v.string(),
    encoding: v.optional(v.string()),
    createdAt: v.number(),
  }).index('byCall', ['callId', 'seq']),

  usage_snapshots: defineTable({
    turnId: v.string(),
    totalInputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningOutputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    modelContextWindow: v.optional(v.number()),
    source: v.optional(v.string()),
    capturedAt: v.number(),
  }).index('byTurn', ['turnId', 'capturedAt']),

  rate_limits: defineTable({
    turnId: v.string(),
    scope: v.string(), // primary|secondary|credits
    usedPercent: v.optional(v.number()),
    windowMinutes: v.optional(v.number()),
    resetsAt: v.optional(v.number()),
    balance: v.optional(v.string()),
    unlimited: v.optional(v.boolean()),
    hasCredits: v.optional(v.boolean()),
    capturedAt: v.number(),
  }).index('byTurn', ['turnId', 'capturedAt']),

  events_raw: defineTable({
    conversationId: v.string(),
    turnId: v.optional(v.string()),
    method: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  }).index('byConversation', ['conversationId', 'receivedAt']),
})
