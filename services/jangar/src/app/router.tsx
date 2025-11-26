import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

const NotFound = () => (
  <div className="flex flex-1 items-center justify-center py-16 text-center text-slate-200">
    <div className="space-y-2">
      <p className="text-sm uppercase tracking-wide text-slate-400">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-400">Check the URL or return to the dashboard.</p>
    </div>
  </div>
)

export type RouterContext = {
  queryClient: QueryClient
}

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
      },
    },
  })

export const getRouter = () => {
  const queryClient = createQueryClient()

  return createRouter({
    routeTree,
    context: {
      queryClient,
    },
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
