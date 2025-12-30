import { createRouter } from '@tanstack/react-router'

// Import the generated route tree
import { routeTree } from './routeTree.gen'

if (import.meta.env.SSR) {
  void import('~/server/agent-comms-runtime').catch((error) => {
    console.warn('Failed to load agent comms runtime', error)
  })
}

// Create a new router instance
export const getRouter = () => {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  })

  return router
}
