import type { AgentsServerRouteHandler } from './http-runtime'

type AgentsServerRouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

export type AgentsServerRouteArgs = Parameters<AgentsServerRouteHandler>[0]

export type AgentsFileRouteOptions = {
  server?: {
    handlers?: Partial<Record<AgentsServerRouteMethod, AgentsServerRouteHandler>>
  }
}

export type AgentsFileRoute = {
  path: string
  options: AgentsFileRouteOptions
}

export const createFileRoute =
  (path: string) =>
  (options: AgentsFileRouteOptions): AgentsFileRoute => ({
    path,
    options,
  })
