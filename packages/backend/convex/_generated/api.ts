// Minimal handcrafted Convex API references for CI builds.
// The real file would normally be produced by `convex codegen`, but that
// requires cloud credentials in CI. We expose the function references used by
// the frontend so hooks like `useQuery` have valid targets at runtime.

import { makeFunctionReference } from 'convex/server'

type AgentRecord = {
  _id: string
  slug: string
  name: string
  description: string
  modelSlug: string
  status: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

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

export const api = {
  agents: {
    list: makeFunctionReference<'query', {}, AgentRecord[]>('agents:list'),
    create: makeFunctionReference<
      'mutation',
      {
        name: string
        description?: string
        modelSlug: string
        tags?: string[]
      },
      { slug: string }
    >('agents:create'),
  },
  models: {
    list: makeFunctionReference<
      'query',
      {
        limit?: number
        category?: string
        provider?: string
        featured?: boolean
      },
      ModelRecord[]
    >('models:list'),
    upsert: makeFunctionReference<
      'mutation',
      {
        slug: string
        title: string
        text: string
        provider: string
        category: string
        icon?: string
        tags?: string[]
        featured?: boolean
        order?: number
      },
      { status: 'updated' | 'inserted'; slug: string }
    >('models:upsert'),
    seed: makeFunctionReference<'mutation', {}, { inserted: number; skipped: boolean }>('models:seed'),
  },
}

export type Api = typeof api
