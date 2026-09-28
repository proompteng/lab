#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'

const projectRoot = join(import.meta.dir, '..')
const stateDir = join(projectRoot, '.temporal-cli')
const pidFile = join(projectRoot, '.temporal-cli.pid')
const logFile = resolvePath(process.env.TEMPORAL_CLI_LOG_PATH, join(projectRoot, '.temporal-cli.log'))
const logDir = dirname(logFile)

const temporalPort = Number(process.env.TEMPORAL_PORT ?? 7233)
const temporalUiPort = Number(process.env.TEMPORAL_UI_PORT ?? 8233)
const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
const dbPath = process.env.TEMPORAL_DB_PATH ?? join(stateDir, 'temporal-dev.db')
const temporalCliOverride = process.env.TEMPORAL_CLI_PATH?.trim()
const timeSkippingEnabled = (() => {
  const value = process.env.TEMPORAL_TIME_SKIPPING?.trim().toLowerCase()
  return value ? ['1', 'true', 't', 'yes', 'y', 'on'].includes(value) : false
})()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function resolveTemporalExecutable(): string {
  const attempts: Array<{ candidate: string; error: string }> = []
  const home = process.env.HOME?.trim()
  const candidates = temporalCliOverride
    ? [temporalCliOverride]
    : [
        'temporal',
        ...(home ? [`${home}/.temporalio/bin/temporal`, `${home}/.local/bin/temporal`] : []),
        '/usr/local/bin/temporal',
        '/usr/bin/temporal',
        '/opt/homebrew/bin/temporal',
      ]

  for (const candidate of candidates) {
    try {
      const result = Bun.spawnSync([candidate, '--help'], { stdout: 'ignore', stderr: 'pipe' })
      if (result.exitCode === 0) {
        return candidate
      }
      const stderrMsg = result.stderr ? new TextDecoder().decode(result.stderr) : `exit code ${result.exitCode}`
      attempts.push({ candidate, error: stderrMsg.trim() })
    } catch (error) {
      attempts.push({ candidate, error: error instanceof Error ? error.message : String(error) })
    }
  }

  console.error(
    'Unable to locate a working Temporal CLI executable. Set TEMPORAL_CLI_PATH or install https://github.com/temporalio/cli',
  )
  for (const { candidate, error } of attempts) {
    console.error(`  - ${candidate}: ${error}`)
  }
  process.exit(1)
}

async function waitForPort(host: string, port: number, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const canConnect = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (canConnect) return
    await Bun.sleep(500)
  }
  throw new Error(`Temporal CLI server did not start listening on ${host}:${port} within ${timeoutMs}ms`)
}

function readExistingPid(): number | null {
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    if (!raw) return null
    const pid = Number(raw)
    if (Number.isNaN(pid)) return null
    return pid
  } catch {
    return null
  }
}

function writePid(pid: number) {
  writeFileSync(pidFile, String(pid), 'utf8')
}

function startTemporalCli(executable: string) {
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(logDir, { recursive: true })
  const logFd = openSync(logFile, 'w')
  try {
    const child = spawn(
      executable,
      [
        'server',
        'start-dev',
        '--namespace',
        temporalNamespace,
        '--db-filename',
        dbPath,
        '--port',
        String(temporalPort),
        '--ui-port',
        String(temporalUiPort),
        ...(timeSkippingEnabled ? ['--time-skipping'] : []),
      ],
      {
        cwd: stateDir,
        stdio: ['ignore', logFd, logFd],
        detached: true,
      },
    )

    child.unref()
    writePid(child.pid)
    return child.pid
  } finally {
    closeSync(logFd)
  }
}

async function main() {
  const executable = resolveTemporalExecutable()

  const existingPid = readExistingPid()
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Temporal CLI already running with PID ${existingPid}. Stop it first (pid file: ${pidFile}).`)
    process.exit(1)
  } else if (existingPid) {
    rmSync(pidFile)
  }

  const pid = startTemporalCli(executable)
  console.log(`Temporal CLI starting (PID ${pid}). Logs: ${logFile}`)
  try {
    await waitForPort('127.0.0.1', temporalPort)
    console.log(`Temporal CLI is ready on 127.0.0.1:${temporalPort} (UI: http://127.0.0.1:${temporalUiPort})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // ignore
    }
    rmSync(pidFile, { force: true })
    process.exit(1)
  }
}

function resolvePath(override: string | undefined, fallback: string): string {
  if (!override) {
    return fallback
  }
  const trimmed = override.trim()
  if (!trimmed) {
    return fallback
  }
  return isAbsolute(trimmed) ? trimmed : join(projectRoot, trimmed)
}

await main()
