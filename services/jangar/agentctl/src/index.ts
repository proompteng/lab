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

import { makeApp } from './cli/app'
import { makeAgentctlContextLayer } from './cli/context'
import { exitCodeFor, formatError, isAgentctlError } from './cli/errors'
import { parseGlobalFlags } from './cli/global-flags'
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

const main = async () => {
  const { argv, flags } = parseGlobalFlags(process.argv.slice(2))
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
    teardown: handleExit,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(EXIT_UNKNOWN)
})
