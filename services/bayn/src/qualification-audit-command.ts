import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger, Schema, Stdio, Stream } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import type { QualificationAuditReport } from './audit/audit'
import type { QualificationDossier } from './audit/dossier'
import {
  qualificationAuditConfig,
  qualificationAuditCommandError,
  type AuditConfig,
  type QualificationAuditCommandError,
} from './qualification/audit-command/model'
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
type QualificationAuditOutput = QualificationAuditReport | QualificationDossier

export const requireQualificationAuditReport = (
  report: QualificationAuditOutput,
): Effect.Effect<QualificationAuditReport, QualificationAuditCommandError> =>
  'status' in report
    ? Effect.succeed(report)
    : Effect.fail(qualificationAuditCommandError('audit', 'qualification audit command produced a dossier'))

export const renderQualificationAuditCommandOutput = (
  report: QualificationAuditOutput,
): Effect.Effect<string, QualificationAuditCommandError> =>
  encodeJson(report).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError('audit', 'qualification audit output encoding failed', cause),
    ),
    Effect.map((output) => `${output}\n`),
  )

export const completeQualificationAuditCommand = (
  input: Pick<AuditConfig, 'output'>,
  report: QualificationAuditOutput,
): Effect.Effect<void, QualificationAuditCommandError> =>
  input.output === 'audit' && 'status' in report && report.status !== 'PASS'
    ? Effect.fail(qualificationAuditCommandError('audit', 'qualification audit failed'))
    : Effect.void

const collectQualificationAuditOutput = Effect.gen(function* () {
  const input = yield* qualificationAuditConfig
  const report = yield* runQualificationAudit(
    input,
    makeQualificationAuditReaders(input, liveQualificationAuditAcquirers),
  )
  return { input, report }
})

export const collectQualificationAuditReport = collectQualificationAuditOutput.pipe(
  Effect.flatMap(({ report }) => requireQualificationAuditReport(report)),
)

const main = Effect.gen(function* () {
  const { input, report } = yield* collectQualificationAuditOutput
  const output = yield* renderQualificationAuditCommandOutput(report)
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(output), stdio.stdout())
  yield* completeQualificationAuditCommand(input, report)
})

const runtime = Layer.mergeAll(Logger.layer([Logger.consoleJson]), NodeServices.layer, Reactivity.layer)
const program = main.pipe(Effect.annotateLogs({ service: 'bayn-qualification-audit' }), Effect.provide(runtime))

if (import.meta.main) NodeRuntime.runMain(program)
