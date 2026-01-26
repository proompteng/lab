import { defineNitroPlugin } from 'nitro/runtime'

export default defineNitroPlugin((nitroApp) => {
  const app = nitroApp as typeof nitroApp & { _h3?: unknown; h3App?: unknown }
  if (!app.h3App && app._h3) {
    app.h3App = app._h3
  }
})
