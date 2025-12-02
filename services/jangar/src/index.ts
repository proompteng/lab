import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startUiServer } from './dev-server'
import { getAppServer, stopAppServer } from './services/app-server'
import { startTemporalWorker } from './workers/temporal-worker'

const serviceRoot = fileURLToPath(new URL('..', import.meta.url))
const bunBin = process.execPath
const bunDir = bunBin.includes('/') ? bunBin.substring(0, bunBin.lastIndexOf('/')) : ''
const withBunPath = (env: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  ...env,
  PATH: [bunDir, process.env.PATH].filter(Boolean).join(':'),
})
const devMode = Bun.argv.includes('--dev') || Bun.env.START_DEV === '1'
const enableWorker = Bun.env.ENABLE_TEMPORAL_WORKER !== '0' && Bun.env.DISABLE_TEMPORAL_WORKER !== '1'

const onSignal = (cleanup: () => Promise<void>) => {
  const handler = (_signal: string) => {
    cleanup()
      .catch((error) => {
        console.error('Error while shutting down', error)
      })
      .finally(() => {
        process.exit(0)
      })
  }

  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
}

const runProd = async () => {
  const appServer = getAppServer(Bun.env.CODEX_BIN ?? 'codex', Bun.env.CODEX_CWD)
  const worker = enableWorker ? await startTemporalWorker() : null
  const uiProcess = startUiServer()
  const uiExit = uiProcess.exited.then((code) => {
    if (code !== 0) {
      throw new Error(`TanStack Start server exited with code ${code ?? 'unknown'}`)
    }
  })

  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    if (worker) {
      await worker.shutdown()
    }
    await stopAppServer(appServer)
    uiProcess.kill()
  }

  onSignal(cleanup)

  try {
    await appServer.ready
    if (worker) {
      await Promise.race([worker.runPromise, uiExit])
    } else {
      await uiExit
    }
  } finally {
    await cleanup()
  }
}

const runDev = async () => {
  const workerProcess = Bun.spawn({
    cmd: [bunBin, '--watch', join('src', 'worker.ts')],
    cwd: serviceRoot,
    stdout: 'inherit',
    stderr: 'inherit',
    env: withBunPath(),
  })

  const uiProcess = startUiServer({ dev: true })

  const workerExit = workerProcess.exited.then((code) => {
    if (code !== 0) {
      throw new Error(`Temporal worker (watch) exited with code ${code ?? 'unknown'}`)
    }
  })

  const uiExit = uiProcess.exited.then((code) => {
    if (code !== 0) {
      throw new Error(`TanStack Start dev server exited with code ${code ?? 'unknown'}`)
    }
  })

  onSignal(async () => {
    workerProcess.kill()
    uiProcess.kill()
  })

  await Promise.race([uiExit, workerExit])
}

if (devMode) {
  await runDev()
} else {
  await runProd()
}
