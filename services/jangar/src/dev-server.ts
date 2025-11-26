import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type UiServerOptions = {
  dev?: boolean
}

// Resolve to the service root (services/jangar) so cwd values exist
const serviceRoot = fileURLToPath(new URL('..', import.meta.url))
const uiDir = join(serviceRoot, 'src')
const distEntry = join(serviceRoot, 'dist', 'ui', 'server', 'index.mjs')
// Default to 3000 for the TanStack Start dev server
const uiDevPort = Bun.env.UI_PORT ?? '3000'
const uiProdPort = Bun.env.UI_PORT ?? Bun.env.PORT ?? '3000'
const openwebuiPort = Bun.env.OPENWEBUI_PORT ?? '8080'
const defaultOpenwebuiUrl = Bun.env.OPENWEBUI_URL ?? `http://localhost:${openwebuiPort}`
const bunBin = process.execPath
const bunDir = bunBin.includes('/') ? bunBin.substring(0, bunBin.lastIndexOf('/')) : ''
const withBunPath = (env: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  ...env,
  PATH: [bunDir, process.env.PATH].filter(Boolean).join(':'),
})

export const startUiServer = ({ dev = false }: UiServerOptions = {}) => {
  if (dev) {
    return Bun.spawn({
      cmd: [bunBin, '--bun', 'vite', 'dev', '--host', '--port', uiDevPort],
      cwd: uiDir,
      stdout: 'inherit',
      stderr: 'inherit',
      env: withBunPath({
        UI_PORT: uiDevPort,
        PORT: uiDevPort,
        OPENWEBUI_PORT: openwebuiPort,
        VITE_OPENWEBUI_PORT: openwebuiPort,
        VITE_OPENWEBUI_URL: defaultOpenwebuiUrl,
      }),
    })
  }

  if (!existsSync(distEntry)) {
    throw new Error('TanStack Start dist missing at dist/ui/server/index.mjs. Run `bun run start:build`.')
  }

  return Bun.spawn({
    cmd: [bunBin, distEntry],
    cwd: serviceRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    env: withBunPath({
      PORT: uiProdPort,
      OPENWEBUI_PORT: openwebuiPort,
      VITE_OPENWEBUI_PORT: openwebuiPort,
      VITE_OPENWEBUI_URL: defaultOpenwebuiUrl,
    }),
  })
}
