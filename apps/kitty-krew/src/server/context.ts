import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
// biome-ignore lint/suspicious/noEmptyInterface: this is a placeholder for the context
interface CreateContextOptions {
  // session: Session | null
}

/**
 * Inner function for `createContext` where we create the context.
 * This is useful for testing when we don't want to mock Next.js' request/response
 */
export async function createContextInner(_opts: CreateContextOptions) {
  return {}
}

export type Context = Awaited<ReturnType<typeof createContextInner>>

/**
 * Creates context for an incoming request
 * @see https://trpc.io/docs/v11/context
 */
export async function createContext(_opts: FetchCreateContextFnOptions): Promise<Context> {
  // for API-response caching see https://trpc.io/docs/v11/caching

  return await createContextInner({})
}
