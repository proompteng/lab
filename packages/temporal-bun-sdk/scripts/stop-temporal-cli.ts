#!/usr/bin/env bun

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const projectRoot = join(import.meta.dir, '..')
const pidFile = join(projectRoot, '.temporal-cli.pid')

function readPid(): number | null {
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    if (!raw) return null
    const pid = Number(raw)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function waitForExit(pid: number, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0)
      Bun.sleepSync(500)
    } catch {
      return
    }
  }
  throw new Error(`Process ${pid} did not exit after ${timeoutMs}ms`)
}

function main() {
  const pid = readPid()
  if (!pid) {
    console.error(`No Temporal CLI pid file found at ${pidFile}. Nothing to stop.`)
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    console.error(`Process ${pid} is not running. Removing stale pid file.`)
    rmSync(pidFile, { force: true })
    return
  }

  try {
    waitForExit(pid)
  } catch {
    console.warn(`Process ${pid} did not exit gracefully; sending SIGKILL.`)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  } finally {
    rmSync(pidFile, { force: true })
  }

  console.log('Temporal CLI dev server stopped.')
}

main()
