declare module '*.css?url' {
  const href: string
  export default href
}

declare module '@xterm/addon-ligatures/lib/addon-ligatures.mjs' {
  export { LigaturesAddon } from '@xterm/addon-ligatures'
}

type JangarServerRouteArgs = {
  request: Request
  params: Record<string, string>
}

type JangarServerRouteArgsWith<TParams extends Record<string, string>> = {
  request: Request
  params: TParams
}

type JangarServerRouteHandler = (args: JangarServerRouteArgs) => Response | Promise<Response>

type JangarServerRouteHandlers = Partial<Record<'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT', JangarServerRouteHandler>>

type JangarGithubPullRouteParams = {
  owner: string
  repo: string
  number: string
}

type JangarGithubPullThreadRouteParams = JangarGithubPullRouteParams & {
  threadId: string
}

declare module '@tanstack/router-core' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}

declare module '@tanstack/router-core/dist/esm/route' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}

declare module '@tanstack/router-core/dist/esm/route.js' {
  interface FilebaseRouteOptionsInterface<
    TRegister,
    TParentRoute extends import('@tanstack/router-core').AnyRoute = import('@tanstack/router-core').AnyRoute,
    TId extends string = string,
    TPath extends string = string,
    TSearchValidator = undefined,
    TParams = {},
    TLoaderDeps extends Record<string, any> = {},
    TLoaderFn = undefined,
    TRouterContext = {},
    TRouteContextFn = import('@tanstack/router-core').AnyContext,
    TBeforeLoadFn = import('@tanstack/router-core').AnyContext,
    TRemountDepsFn = import('@tanstack/router-core').AnyContext,
    TSSR = unknown,
    TServerMiddlewares = unknown,
    THandlers = undefined,
  > {
    server?: {
      handlers?: JangarServerRouteHandlers
    }
  }
}
