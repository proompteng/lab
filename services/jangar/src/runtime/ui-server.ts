import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type UiServerOptions = {
  dev?: boolean
}

const serviceRoot = fileURLToPath(new URL('../..', import.meta.url))
const uiDir = join(serviceRoot, 'src', 'ui')
const distEntry = join(serviceRoot, 'dist', 'ui', 'server', 'index.mjs')
const uiPort = Bun.env.UI_PORT ?? Bun.env.PORT ?? '8080'

export const startUiServer = ({ dev = false }: UiServerOptions = {}) => {
  if (dev) {
    return Bun.spawn({
      cmd: ['bunx', 'vite', 'dev', '--host'],
      cwd: uiDir,
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, PORT: uiPort },
    })
  }

  if (!existsSync(distEntry)) {
    throw new Error('TanStack Start dist missing at dist/ui/server/index.mjs. Run `bun run start:build`.')
  }

  return Bun.spawn({
    cmd: ['bun', distEntry],
    cwd: serviceRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PORT: uiPort },
  })
}
