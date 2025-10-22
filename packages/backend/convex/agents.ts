import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const DEFAULT_STATUS = 'active' as const

export const list = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query('agents').collect()

    return docs
      .map((doc) => ({
        ...doc,
        tags: doc.tags ?? [],
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  },
})

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    modelSlug: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const slug = slugify(args.name)

    const existing = await ctx.db
      .query('agents')
      .withIndex('bySlug', (q) => q.eq('slug', slug))
      .unique()

    if (existing) {
      throw new Error(`agent with slug ${slug} already exists`)
    }

    const doc = {
      slug,
      name: args.name,
      description: args.description ?? '',
      modelSlug: args.modelSlug,
      status: DEFAULT_STATUS,
      tags: (args.tags ?? []).map((tag) => tag.toLowerCase()),
      createdAt: now,
      updatedAt: now,
    }

    await ctx.db.insert('agents', doc)

    return { slug }
  },
})

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
