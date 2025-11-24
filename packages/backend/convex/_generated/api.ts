// Minimal handcrafted Convex API references for CI builds.
// The real file would normally be produced by `convex codegen`, but that
// requires cloud credentials in CI. We expose the function references used by
// the frontend so hooks like `useQuery` have valid targets at runtime.

import { makeFunctionReference } from 'convex/server'

export const api = {
  agents: {
    list: makeFunctionReference<'query', { }>('agents:list'),
    create: makeFunctionReference<
      'mutation',
      {
        name: string
        description?: string
        modelSlug: string
        tags?: string[]
      }
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
      }
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
      }
    >('models:upsert'),
    seed: makeFunctionReference<'mutation', {}>('models:seed'),
  },
}

export type Api = typeof api

