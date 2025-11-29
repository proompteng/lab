import { v } from 'convex/values'
import { mutation } from './_generated/server'

// Conversations
export const upsertConversation = mutation({
  args: {
    conversationId: v.string(),
    threadId: v.optional(v.string()),
    modelProvider: v.optional(v.string()),
    clientName: v.optional(v.string()),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('conversations')
      .withIndex('byConversationId', (q) => q.eq('conversationId', args.conversationId))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        threadId: args.threadId ?? existing.threadId,
        modelProvider: args.modelProvider ?? existing.modelProvider,
        clientName: args.clientName ?? existing.clientName,
        lastSeenAt: args.at,
      })
      return existing._id
    }

    return ctx.db.insert('conversations', {
      conversationId: args.conversationId,
      threadId: args.threadId,
      modelProvider: args.modelProvider,
      clientName: args.clientName,
      startedAt: args.at,
      lastSeenAt: args.at,
    })
  },
})

// Turns
export const upsertTurn = mutation({
  args: {
    turnId: v.string(),
    conversationId: v.string(),
    chatId: v.optional(v.string()),
    userId: v.optional(v.string()),
    model: v.optional(v.string()),
    serviceTier: v.optional(v.string()),
    status: v.string(),
    error: v.optional(v.string()),
    path: v.optional(v.string()),
    turnNumber: v.optional(v.number()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('turns')
      .withIndex('byTurnId', (q) => q.eq('turnId', args.turnId))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        error: args.error,
        chatId: args.chatId ?? existing.chatId,
        userId: args.userId ?? existing.userId,
        model: args.model ?? existing.model,
        serviceTier: args.serviceTier ?? existing.serviceTier,
        path: args.path ?? existing.path,
        turnNumber: args.turnNumber ?? existing.turnNumber,
        startedAt: existing.startedAt ?? args.startedAt,
        endedAt: args.endedAt ?? existing.endedAt,
      })
      return existing._id
    }

    return ctx.db.insert('turns', {
      turnId: args.turnId,
      conversationId: args.conversationId,
      chatId: args.chatId,
      userId: args.userId,
      model: args.model,
      serviceTier: args.serviceTier,
      status: args.status,
      error: args.error,
      path: args.path,
      turnNumber: args.turnNumber,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
    })
  },
})

// Messages
export const appendMessage = mutation({
  args: {
    turnId: v.string(),
    role: v.string(),
    content: v.string(),
    rawContent: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('messages', args),
})

// Reasoning sections
export const appendReasoningSection = mutation({
  args: {
    turnId: v.string(),
    itemId: v.string(),
    summaryText: v.optional(v.array(v.string())),
    rawContent: v.optional(v.any()),
    position: v.optional(v.number()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('reasoning_sections', args),
})

// Commands
export const upsertCommand = mutation({
  args: {
    callId: v.string(),
    turnId: v.string(),
    command: v.array(v.string()),
    cwd: v.optional(v.string()),
    source: v.optional(v.string()),
    parsedCmd: v.optional(v.any()),
    status: v.optional(v.string()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    exitCode: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    aggregatedOutput: v.optional(v.string()),
    chunked: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('commands')
      .withIndex('byCallId', (q) => q.eq('callId', args.callId))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        startedAt: existing.startedAt ?? args.startedAt,
      })
      return existing._id
    }

    return ctx.db.insert('commands', args)
  },
})

export const appendCommandChunk = mutation({
  args: {
    callId: v.string(),
    stream: v.string(),
    seq: v.number(),
    chunkBase64: v.string(),
    encoding: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('command_chunks', args),
})

// Usage snapshots
export const appendUsageSnapshot = mutation({
  args: {
    turnId: v.string(),
    totalInputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningOutputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    modelContextWindow: v.optional(v.number()),
    source: v.optional(v.string()),
    capturedAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('usage_snapshots', args),
})

// Rate limits
export const appendRateLimit = mutation({
  args: {
    turnId: v.string(),
    scope: v.string(),
    usedPercent: v.optional(v.number()),
    windowMinutes: v.optional(v.number()),
    resetsAt: v.optional(v.number()),
    balance: v.optional(v.string()),
    unlimited: v.optional(v.boolean()),
    hasCredits: v.optional(v.boolean()),
    capturedAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('rate_limits', args),
})

// Raw events audit
export const appendEvent = mutation({
  args: {
    conversationId: v.string(),
    turnId: v.optional(v.string()),
    method: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => ctx.db.insert('events_raw', args),
})
