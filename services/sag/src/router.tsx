import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
    },
  })

export function createRouter() {
  const queryClient = createQueryClient()

  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPendingComponent: PendingShell,
    Wrap: function Wrap({ children }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    },
  })
}

function PendingShell() {
  return <div className="min-h-screen bg-zinc-950 text-zinc-100" />
}

export function getRouter() {
  return createRouter()
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
