import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import { qualificationAuditConfig, qualificationAuditCommandError } from './qualification/audit-command/model'
import {
  liveQualificationAuditAcquirers,
  makeQualificationAuditReaders,
  runQualificationAudit,
} from './qualification/audit-command/program'

export { readAuditDatabase } from './qualification/audit-command/database'
export { loadAuditSignal } from './qualification/audit-command/signal'
export { readAuditSignalAccess } from './qualification/audit-command/signal-access'
export {
  QualificationAuditCommandError,
  type AcquireAuditDatabaseClient,
  type AcquireAuditRepositoryClient,
  type AcquireAuditSignalClient,
  type AcquireAuditSignalReplicaClient,
  type AuditConfig,
  type AuditDatabaseClient,
  type AuditRepositoryClient,
  type AuditSignalClient,
  type AuditSignalReplicaClient,
  type QualificationAuditAcquirers,
  type QualificationAuditReaders,
  type SignalReplicaAccess,
} from './qualification/audit-command/model'
export { makeQualificationAuditReaders, runQualificationAudit } from './qualification/audit-command/program'

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const main = Effect.gen(function* () {
  const input = yield* qualificationAuditConfig
  const report = yield* runQualificationAudit(
    input,
    makeQualificationAuditReaders(input, liveQualificationAuditAcquirers),
  )
  const output = yield* encodeJson(report).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError('audit', 'qualification audit output encoding failed', cause),
    ),
  )
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
  if (input.output === 'audit' && 'status' in report && report.status !== 'PASS') {
    return yield* qualificationAuditCommandError('audit', 'qualification audit failed')
  }
})

const runtime = Layer.mergeAll(Logger.layer([Logger.consoleJson]), NodeServices.layer, Reactivity.layer)
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-qualification-audit' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
