import { access } from 'node:fs/promises'
import process from 'node:process'

import { createLogger } from './logger'
import { SymphonyOrchestrator } from './orchestrator'
import { SymphonyHttpServer } from './http-server'
import { toError } from './errors'

const parseArgs = (argv: string[]) => {
  let workflowPath = './WORKFLOW.md'
  let host: string | null = null
  let port: number | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--host requires a value')
      }
      host = value
      index += 1
      continue
    }
    if (arg === '--port') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--port requires a value')
      }
      port = Number.parseInt(value, 10)
      index += 1
      continue
    }
    workflowPath = arg
  }

  return { workflowPath, host, port }
}

const main = async () => {
  const logger = createLogger({ service: 'symphony' })
  const { workflowPath, host: cliHost, port: cliPort } = parseArgs(process.argv.slice(2))
  await access(workflowPath)

  const orchestrator = new SymphonyOrchestrator(workflowPath, logger)
  await orchestrator.start()

  let httpServer: SymphonyHttpServer | null = null
  const workflowServer = (await orchestrator.getCurrentConfig()).server
  const hostToUse = cliHost ?? workflowServer.host
  const workflowPort = workflowServer.port
  const portToUse = cliPort ?? workflowPort
  if (portToUse !== null && Number.isFinite(portToUse)) {
    httpServer = new SymphonyHttpServer(orchestrator, logger)
    httpServer.start(portToUse, hostToUse)
  }

  const shutdown = async () => {
    httpServer?.stop()
    await orchestrator.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  const logger = createLogger({ service: 'symphony' })
  logger.log('error', 'startup_failed', { error: toError(error).message })
  process.exit(1)
})
