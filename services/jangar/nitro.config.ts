import { defineNitroConfig } from 'nitro/config'

const websocketEnabled = ['1', 'true', 'yes', 'on'].includes(
  (process.env.JANGAR_WEBSOCKETS_ENABLED ?? '').toLowerCase(),
)

export default defineNitroConfig({
  preset: 'bun',
  experimental: {
    websocket: websocketEnabled,
  },
})
