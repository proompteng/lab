import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startUiServer } from './dev-server'
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
  const { runPromise, shutdown } = await startTemporalWorker()
  const uiProcess = startUiServer()
  const uiExit = uiProcess.exited.then((code) => {
    if (code !== 0) {
      throw new Error(`TanStack Start server exited with code ${code ?? 'unknown'}`)
    }
  })

  onSignal(async () => {
    await shutdown()
    uiProcess.kill()
  })

  await Promise.race([runPromise, uiExit])
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
