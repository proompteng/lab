import { createRouter } from '@tanstack/react-router'
import { Route as SlugRoute } from './routes/$slug'
import { routeTree } from './routeTree.gen'

const appRouteTree = routeTree.addChildren([SlugRoute])

export const getRouter = () =>
  createRouter({
    routeTree: appRouteTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  })
