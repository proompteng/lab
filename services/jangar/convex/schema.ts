import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  chat_sessions: defineTable({
    userId: v.string(),
    title: v.string(),
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  }),

  chat_messages: defineTable({
    sessionId: v.string(),
    role: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index('bySessionCreated', ['sessionId', 'createdAt'])
    .index('bySessionUpdated', ['sessionId', 'updatedAt']),

  work_orders: defineTable({
    sessionId: v.string(),
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
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index('bySessionCreated', ['sessionId', 'createdAt'])
    .index('byStatusUpdated', ['status', 'updatedAt']),
})
