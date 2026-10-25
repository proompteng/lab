#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exit } from 'node:process'

import { Effect, Exit } from 'effect'

import { executeReplay } from '../src/bin/replay-command'
import { runTemporalCliEffect } from '../src/runtime/cli-layer'

// TODO(TBS-NDG-004): replay CI gate runner

const truthy = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const isTruthy = (value: string | undefined): boolean => Boolean(value && truthy.has(value.trim().toLowerCase()))

const parseArgs = (argv: string[]) => {
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith('-')) continue
    const key = value.replace(/^-+/, '')
    const next = argv[index + 1]
    if (next && !next.startsWith('-')) {
      flags[key] = next
      index++
    } else {
      flags[key] = true
    }
  }
  return flags
}

const main = async () => {
  const flags = parseArgs(process.argv.slice(2))
  const historyDir = typeof flags['history-dir'] === 'string' ? flags['history-dir'] : undefined
  const outDir = typeof flags.out === 'string' ? flags.out : undefined
  const required = isTruthy(process.env.TEMPORAL_REPLAY_GATE_REQUIRED) || isTruthy(process.env.REPLAY_GATE_REQUIRED)

  if (!historyDir) {
    console.error('replay-ci-gate requires --history-dir <path>')
    exit(1)
    return
  }

  const resolvedHistoryDir = resolve(process.cwd(), historyDir)
  if (!existsSync(resolvedHistoryDir)) {
    if (required) {
      console.error(`replay-ci-gate required histories missing: ${resolvedHistoryDir}`)
      exit(1)
    } else {
      console.warn(`replay-ci-gate skipped (no histories): ${resolvedHistoryDir}`)
      exit(0)
    }
    return
  }

  const resolvedOutDir = outDir ? resolve(process.cwd(), outDir) : undefined
  if (resolvedOutDir) {
    await mkdir(resolvedOutDir, { recursive: true })
  }

  const effect = executeReplay({
    'history-dir': resolvedHistoryDir,
    ...(resolvedOutDir ? { out: resolvedOutDir } : {}),
    json: true,
  })

  const resultExit = await Effect.runPromiseExit(runTemporalCliEffect(effect, { config: { env: process.env } }))
  if (Exit.isFailure(resultExit)) {
    console.error(resultExit.cause)
    exit(1)
    return
  }

  const result = resultExit.value
  exit(result.exitCode ?? 1)
}

await main()
