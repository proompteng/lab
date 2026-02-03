#!/usr/bin/env node
import process from 'node:process'

import { Command, HelpDoc, ValidationError } from '@effect/cli'
import { BunContext, BunRuntime } from '@effect/platform-bun'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { spawn } from 'node:child_process'

import { makeApp } from './cli/app'
import { makeAgentctlContextLayer } from './cli/context'
import { exitCodeFor, formatError, isAgentctlError } from './cli/errors'
import { parseGlobalFlags } from './cli/global-flags'
import { renderGlobalFlags } from './cli/help'
import { loadConfig, resolveConfig } from './config'
import { EXIT_UNKNOWN, EXIT_VALIDATION, getVersion } from './legacy'
import { TransportLive } from './transport'

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
const platformLayer = isBun ? BunContext.layer : NodeContext.layer
const runMain = isBun ? BunRuntime.runMain : NodeRuntime.runMain

const handleExit = (exit: Exit.Exit<unknown, unknown>, onExit: (code: number) => void) => {
  if (Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)) {
    onExit(0)
    return
  }

  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
  if (failure && ValidationError.isValidationError(failure)) {
    const text = HelpDoc.toAnsiText(failure.error)
    if (failure._tag === 'HelpRequested') {
      console.log(text)
      console.log(renderGlobalFlags())
      onExit(0)
    } else {
      console.error(text)
      onExit(EXIT_VALIDATION)
    }
    return
  }

  if (isAgentctlError(failure)) {
    const message = formatError(failure)
    if (message) console.error(message)
    onExit(exitCodeFor(failure))
    return
  }

  const message = failure instanceof Error ? failure.message : failure ? String(failure) : 'Unknown error'
  if (process.env.AGENTCTL_DEBUG) {
    console.error(Cause.pretty(exit.cause))
  } else if (message) {
    console.error(message)
  }
  onExit(EXIT_UNKNOWN)
}

const setupPager = (enabled?: boolean) => {
  if (!enabled) return null
  if (!process.stdout.isTTY) return null
  const pager = process.env.PAGER?.trim() || 'less -FRX'
  const [cmd, ...args] = pager.split(' ').filter(Boolean)
  if (!cmd) return null
  let child: ReturnType<typeof spawn> | null = null
  try {
    child = spawn(cmd, args, { stdio: ['pipe', process.stdout, process.stderr] })
  } catch {
    return null
  }
  const originalWrite = process.stdout.write.bind(process.stdout)
  if (!child || !child.stdin) return null
  process.stdout.write = child.stdin.write.bind(child.stdin)
  child.on('error', () => {
    process.stdout.write = originalWrite
  })
  return () => {
    try {
      child?.stdin?.end()
    } catch {
      // ignore
    }
    process.stdout.write = originalWrite
  }
}

const main = async () => {
  const { argv, flags } = parseGlobalFlags(process.argv.slice(2))
  if (flags.noInput) {
    process.env.AGENTCTL_NO_INPUT = '1'
  }
  if (flags.color === false) {
    process.env.NO_COLOR = '1'
  }
  const teardownPager = setupPager(flags.pager)
  const commandArgv = [process.argv[0] ?? 'node', process.argv[1] ?? 'agentctl', ...argv]
  const config = await loadConfig()
  const { resolved, warnings } = resolveConfig(flags, config)
  warnings.forEach((warning) => {
    console.warn(`warning: ${warning}`)
  })

  const contextLayer = makeAgentctlContextLayer({
    argv,
    flags,
    config,
    resolved,
  })
  const transportLayer = Layer.provide(TransportLive, contextLayer)
  const appLayer = Layer.mergeAll(contextLayer, transportLayer)
  const runtimeLayer = Layer.mergeAll(appLayer, platformLayer)
  const app = makeApp()
  const run = Command.run({ name: 'agentctl', version: getVersion() })(app)
  const program = Effect.provide(run(commandArgv), runtimeLayer)

  runMain(program, {
    disableErrorReporting: true,
    disablePrettyLogger: true,
    teardown: (exit, onExit) => {
      if (teardownPager) teardownPager()
      handleExit(exit, onExit)
    },
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(EXIT_UNKNOWN)
})
