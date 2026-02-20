import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  models: defineTable({
    slug: v.string(),
    title: v.string(),
    text: v.string(),
    provider: v.string(),
    category: v.string(),
    icon: v.optional(v.string()),
    tags: v.array(v.string()),
    featured: v.boolean(),
    order: v.number(),
    updatedAt: v.number(),
  })
    .index('bySlug', ['slug']) // fetch individual models quickly
    .index('byProvider', ['provider'])
    .index('byCategory', ['category'])
    .index('byFeatured', ['featured', 'order']),
  agents: defineTable({
    slug: v.string(),
    name: v.string(),
    description: v.string(),
    modelSlug: v.string(),
    status: v.string(),
    tags: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('bySlug', ['slug'])
    .index('byStatus', ['status', 'updatedAt']),
  liveSessions: defineTable({
    site: v.string(),
    sessionId: v.string(),
    visitorIdHash: v.string(),
    path: v.string(),
    lastSeenAt: v.number(),
    expiresAt: v.number(),
    updatedAt: v.number(),
  })
    .index('bySession', ['sessionId'])
    .index('bySiteExpires', ['site', 'expiresAt']),
})
