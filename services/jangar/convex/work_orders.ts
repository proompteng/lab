import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

export const create = mutation({
  args: {
    sessionId: v.id('chat_sessions'),
    workflowId: v.string(),
    githubIssueUrl: v.optional(v.string()),
    prompt: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.string(),
    requestedBy: v.optional(v.string()),
    targetRepo: v.optional(v.string()),
    targetBranch: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = args.createdAt
    const id = await ctx.db.insert('work_orders', {
      sessionId: args.sessionId,
      workflowId: args.workflowId,
      githubIssueUrl: args.githubIssueUrl,
      prompt: args.prompt,
      title: args.title,
      status: args.status,
      requestedBy: args.requestedBy,
      targetRepo: args.targetRepo,
      targetBranch: args.targetBranch,
      prUrl: args.prUrl,
      createdAt: now,
      updatedAt: now,
      deletedAt: undefined,
    })
    return id
  },
})

export const updateStatus = mutation({
  args: {
    workOrderId: v.id('work_orders'),
    status: v.string(),
    at: v.number(),
  },
  handler: async (ctx, { workOrderId, status, at }) => {
    await ctx.db.patch(workOrderId, { status, updatedAt: at })
  },
})

export const updateResult = mutation({
  args: {
    workOrderId: v.id('work_orders'),
    prUrl: v.optional(v.string()),
    updatedAt: v.number(),
  },
  handler: async (ctx, { workOrderId, prUrl, updatedAt }) => {
    await ctx.db.patch(workOrderId, { prUrl, updatedAt })
  },
})

export const listBySession = query({
  args: { sessionId: v.id('chat_sessions') },
  handler: async (ctx, { sessionId }) => {
    return ctx.db
      .query('work_orders')
      .withIndex('bySessionCreated', (q) => q.eq('sessionId', sessionId))
      .collect()
  },
})

export const get = query({
  args: { workOrderId: v.id('work_orders') },
  handler: async (ctx, { workOrderId }) => ctx.db.get(workOrderId),
})
