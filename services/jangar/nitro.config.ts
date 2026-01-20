import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNitroConfig } from 'nitro/config'

const websocketEnabled = ['1', 'true', 'yes', 'on'].includes(
  (process.env.JANGAR_WEBSOCKETS_ENABLED ?? '').toLowerCase(),
)
const rootDir = dirname(fileURLToPath(import.meta.url))
const agentctlPlugin = resolve(rootDir, 'server/plugins/agentctl-grpc')

export default defineNitroConfig({
  preset: 'bun',
  experimental: {
    websocket: websocketEnabled,
  },
  plugins: [agentctlPlugin],
})
