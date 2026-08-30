#!/usr/bin/env node

import process from 'node:process'

import { NodeHttpClient, NodeRuntime } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Cause, Effect, Logger, Redacted } from 'effect'

import { loadConfig } from './config'
import { PublicationError, publicationError } from './errors'
import { parsePublicationArguments, publish } from './publish'
import { makeSnapshotRepository } from './repository'

const run = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () => parsePublicationArguments(process.argv.slice(2)),
    catch: (cause) => publicationError('arguments', 'invalid publisher arguments', cause),
  })
  const config = yield* loadConfig()
  const database = ClickhouseClient.layer({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: Redacted.value(config.clickhouse.password),
    database: 'signal',
    application: 'signal-adjusted-daily-publisher',
    request_timeout: config.operationTimeoutMs,
  })
  return yield* Effect.gen(function* () {
    const repository = yield* makeSnapshotRepository
    return yield* publish(config, args, repository)
  }).pipe(
    Effect.provide([database, NodeHttpClient.layerNodeHttp]),
    Effect.mapError((cause) =>
      cause._tag === 'PublicationError'
        ? cause
        : publicationError('storage', 'failed to initialize Signal ClickHouse client', cause),
    ),
  )
})

const logFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const failure = Cause.squash(cause)
  return Effect.logError('Signal publisher failed').pipe(
    Effect.annotateLogs({
      service: 'signal-publisher',
      event: 'publication_failed',
      phase: failure instanceof PublicationError ? failure.phase : 'runtime',
      error: failure instanceof Error ? failure.message : String(failure),
    }),
  )
}

const program = run.pipe(Effect.tapCause(logFailure), Effect.provide(Logger.layer([Logger.consoleJson])))

NodeRuntime.runMain(program, { disableErrorReporting: true })
