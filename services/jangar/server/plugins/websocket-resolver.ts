import serverEntry from 'virtual:tanstack-start-server-entry'

import { defineNitroPlugin } from 'nitro/runtime'

type WebSocketResolver = (request: Request) => Promise<unknown> | unknown

export default defineNitroPlugin((nitroApp) => {
  const app = nitroApp as typeof nitroApp & {
    h3App: { websocket?: { resolve?: WebSocketResolver } & Record<string, unknown> }
  }

  const existing = app.h3App.websocket ?? {}
  const existingResolve = existing.resolve

  const resolve: WebSocketResolver = async (request) => {
    const response = await serverEntry.fetch(request)
    const crossws = (response as Response & { crossws?: unknown }).crossws
    if (crossws) {
      const pathname = new URL(request.url).pathname
      console.info('[terminals] ws route resolved', { pathname })
      return crossws
    }
    if (existingResolve) {
      return existingResolve(request)
    }
    return undefined
  }

  app.h3App.websocket = { ...existing, resolve }
})
