import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  orchestrations: defineTable({
    orchestrationId: v.string(),
    topic: v.string(),
    repoUrl: v.optional(v.string()),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('byOrchestrationId', ['orchestrationId']),

  turns: defineTable({
    orchestrationId: v.string(),
    index: v.number(),
    threadId: v.optional(v.string()),
    finalResponse: v.string(),
    items: v.any(),
    usage: v.optional(v.any()),
    createdAt: v.number(),
  }).index('byOrchestrationIdIndex', ['orchestrationId', 'index']),

  worker_prs: defineTable({
    orchestrationId: v.string(),
    prUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    commitSha: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  }).index('byOrchestrationIdCreated', ['orchestrationId', 'createdAt']),
})
