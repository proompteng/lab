type AgentsServerRouteMethod = 'DELETE' | 'GET' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT'

export type AgentsServerRouteArgs = {
  request: Request
  params: Record<string, string>
}

export type AgentsServerRouteHandler = (args: AgentsServerRouteArgs) => Response | Promise<Response>

type AgentsFileRouteOptions = {
  server?: {
    handlers?: Partial<Record<AgentsServerRouteMethod, AgentsServerRouteHandler>>
  }
}

type AgentsFileRoute = {
  path: string
  options: AgentsFileRouteOptions
}

export type AgentsServerRouteLoader = () => Promise<{ Route: AgentsFileRoute }>

export const createFileRoute =
  (path: string) =>
  (options: AgentsFileRouteOptions): AgentsFileRoute => ({
    path,
    options,
  })
