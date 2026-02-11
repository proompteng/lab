import { defineNitroPlugin } from 'nitro/runtime'
import { toRequest } from 'h3'

export default defineNitroPlugin((nitroApp) => {
  const app = nitroApp as typeof nitroApp & {
    _h3?: unknown
    h3App?: unknown
  }

  const h3App = app._h3 as
    | ({
        fetch?: (request: Request) => Promise<Response>
        request?: (input: RequestInfo | URL, init?: RequestInit, context?: unknown) => Promise<Response>
      } & Record<string, unknown>)
    | undefined

  // Nitro 3.0.0 expects h3App.request(...), while some H3Core variants expose only fetch(...).
  // Add a compatible request shim so request handling stays stable across h3 implementations.
  if (h3App && typeof h3App.request !== 'function' && typeof h3App.fetch === 'function') {
    h3App.request = (input, init, context) => {
      const request = toRequest(input, init) as Request & { context?: unknown }
      request.context = context ?? request.context
      return h3App.fetch?.(request) as Promise<Response>
    }
  }

  // Some H3Core builds use "~findRoute/~getMiddleware" internals while Nitro wires "_findRoute/_getMiddleware".
  // Mirror those hooks so Nitro route matching works regardless of the installed H3Core shape.
  if (h3App) {
    const legacyFindRoute = h3App._findRoute
    const modernFindRoute = h3App['~findRoute']
    if (typeof modernFindRoute === 'function' && typeof legacyFindRoute === 'function') {
      h3App['~findRoute'] = legacyFindRoute
    }

    const legacyGetMiddleware = h3App._getMiddleware
    const modernGetMiddleware = h3App['~getMiddleware']
    if (typeof modernGetMiddleware === 'function' && typeof legacyGetMiddleware === 'function') {
      h3App['~getMiddleware'] = legacyGetMiddleware
    }
  }

  if (!app.h3App && app._h3) {
    app.h3App = app._h3
  }
})
