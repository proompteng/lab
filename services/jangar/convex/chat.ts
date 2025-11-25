import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import { mutation, query } from './_generated/server'

export const createSession = mutation({
  args: {
    userId: v.string(),
    title: v.string(),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = args.createdAt
    const id = await ctx.db.insert('chat_sessions', {
      userId: args.userId,
      title: args.title,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    })
    return id
  },
})

export const updateLastMessage = mutation({
  args: {
    sessionId: v.id('chat_sessions'),
    at: v.number(),
  },
  handler: async (ctx, { sessionId, at }) => {
    await ctx.db.patch(sessionId, { lastMessageAt: at, updatedAt: at })
  },
})

export const getSession = query({
  args: { sessionId: v.id('chat_sessions') },
  handler: async (ctx, { sessionId }) => ctx.db.get(sessionId),
})

export const listSessions = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db.query('chat_sessions').collect()
    return userId ? sessions.filter((s) => s.userId === userId) : sessions
  },
})

export const appendMessage = mutation({
  args: {
    sessionId: v.id('chat_sessions'),
    role: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = args.createdAt
    const messageId: Id<'chat_messages'> = await ctx.db.insert('chat_messages', {
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    })
    await ctx.db.patch(args.sessionId, { lastMessageAt: now, updatedAt: now })
    return messageId
  },
})

export const listMessages = query({
  args: { sessionId: v.id('chat_sessions') },
  handler: async (ctx, { sessionId }) => {
    return ctx.db
      .query('chat_messages')
      .withIndex('bySessionCreated', (q) => q.eq('sessionId', sessionId))
      .collect()
  },
})
