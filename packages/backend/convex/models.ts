import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const SEED_TIMESTAMP = Date.now()

const SEED_MODELS = [
  {
    slug: 'openai-o1-preview',
    title: 'OpenAI o1-preview',
    text: 'Reasoning-grade frontier model with native tool use and long context support.',
    provider: 'OpenAI',
    category: 'reasoning',
    icon: 'Brain',
    tags: ['reasoning', 'tool-use', 'frontier'],
    featured: true,
    order: 1,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: 'claude-3-5-sonnet',
    title: 'Claude 3.5 Sonnet',
    text: "Anthropic's balanced flagship with 200k context and high compliance scores.",
    provider: 'Anthropic',
    category: 'reasoning',
    icon: 'Brain',
    tags: ['balanced', 'aligned'],
    featured: true,
    order: 2,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: 'gemini-2-0-flash',
    title: 'Gemini 2.0 Flash',
    text: "Google's multimodal stack for real-time agents and streaming responses.",
    provider: 'Google',
    category: 'multimodal',
    icon: 'Cloud',
    tags: ['multimodal', 'streaming'],
    featured: true,
    order: 3,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: 'deepseek-r1',
    title: 'DeepSeek R1',
    text: 'Open reasoning weights optimized for complex workflows and cost efficiency.',
    provider: 'DeepSeek',
    category: 'reasoning',
    icon: 'Server',
    tags: ['open', 'self-host'],
    featured: true,
    order: 4,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: 'llama-3-1-70b',
    title: 'Llama 3.1 70B',
    text: "Meta's self-hostable model with tuned guardrails and policy routing support.",
    provider: 'Meta',
    category: 'self-hosted',
    icon: 'Server',
    tags: ['self-managed', 'policy'],
    featured: true,
    order: 5,
    updatedAt: SEED_TIMESTAMP,
  },
  {
    slug: 'voyage-multipass',
    title: 'Voyage Multipass',
    text: 'High-signal embeddings and rerankers for hybrid RAG pipelines.',
    provider: 'Voyage AI',
    category: 'embeddings',
    icon: 'Database',
    tags: ['embedding', 'rag'],
    featured: true,
    order: 6,
    updatedAt: SEED_TIMESTAMP,
  },
] as const

const normalizeSeed = (input: (typeof SEED_MODELS)[number]): ModelRecord => ({
  ...input,
  tags: input.tags.map((tag) => tag.toLowerCase()),
})

type ModelRecord = {
  slug: string
  title: string
  text: string
  provider: string
  category: string
  icon?: string
  tags: string[]
  featured: boolean
  order: number
  updatedAt: number
}

type ListArgs = {
  limit?: number
  category?: string
  provider?: string
  featured?: boolean
}

type NormalizedListArgs = {
  limit: number
  category: string
  provider: string
  featured: boolean
}

const DEFAULT_LIMIT = 12

export const list = query({
  args: {
    limit: v.optional(v.number()),
    category: v.optional(v.string()),
    provider: v.optional(v.string()),
    featured: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ModelRecord[]> => {
    const normalizedArgs = normalizeArgs(args)
    const docs = await ctx.db.query('models').collect()

    const filtered = docs
      .map(({ _id: _unusedId, _creationTime: _unusedCreation, ...rest }) => ({
        ...rest,
        tags: rest.tags.map((tag) => tag.toLowerCase()),
      }))
      .filter((doc) => filterMatches(doc, normalizedArgs))

    return filtered.sort((a, b) => a.order - b.order).slice(0, normalizedArgs.limit)
  },
})

export const upsert = mutation({
  args: {
    slug: v.string(),
    title: v.string(),
    text: v.string(),
    provider: v.string(),
    category: v.string(),
    icon: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    featured: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const normalized = normalizeMutation(args)

    const existing = await ctx.db
      .query('models')
      .withIndex('bySlug', (q) => q.eq('slug', normalized.slug))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, normalized)
      return { status: 'updated', slug: normalized.slug }
    }

    await ctx.db.insert('models', normalized)
    return { status: 'inserted', slug: normalized.slug }
  },
})

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existingCount = await ctx.db.query('models').collect()
    if (existingCount.length > 0) {
      return { inserted: 0, skipped: true }
    }

    for (const model of SEED_MODELS) {
      await ctx.db.insert('models', normalizeSeed(model))
    }

    return { inserted: SEED_MODELS.length, skipped: false }
  },
})

function normalizeArgs(args: ListArgs): NormalizedListArgs {
  return {
    limit: Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), 50),
    category: args.category?.toLowerCase() ?? '',
    provider: args.provider?.toLowerCase() ?? '',
    featured: args.featured ?? true,
  }
}

function filterMatches(model: ModelRecord, args: NormalizedListArgs): boolean {
  if (args.featured && !model.featured) {
    return false
  }

  if (args.category && model.category.toLowerCase() !== args.category) {
    return false
  }

  if (args.provider && model.provider.toLowerCase() !== args.provider) {
    return false
  }

  return true
}

function normalizeMutation(args: {
  slug: string
  title: string
  text: string
  provider: string
  category: string
  icon?: string
  tags?: string[]
  featured?: boolean
  order?: number
}): ModelRecord {
  return {
    slug: args.slug,
    title: args.title,
    text: args.text,
    provider: args.provider,
    category: args.category,
    icon: args.icon,
    tags: (args.tags ?? []).map((tag) => tag.toLowerCase()),
    featured: args.featured ?? false,
    order: args.order ?? Date.now(),
    updatedAt: Date.now(),
  }
}
