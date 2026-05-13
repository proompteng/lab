import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
})

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    Wrap: function Wrap({ children }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    },
  })
}

export function getRouter() {
  return createRouter()
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
