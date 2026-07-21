import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Logger } from 'effect'

import { EvidenceStoreReadOnlyLive } from './db/evidence-store'
import { JournalLive } from './ledger'
import { loadRestoreConfig, restoreLedger } from './ledger-restore'

const main = loadRestoreConfig().pipe(
  Effect.flatMap((config) => {
    const dependencies = Layer.merge(
      JournalLive(config),
      EvidenceStoreReadOnlyLive(config).pipe(Layer.provide(NodeServices.layer)),
    )
    return restoreLedger(config).pipe(
      Effect.tap((receipt) =>
        Effect.logInfo('Bayn ledger restore completed').pipe(
          Effect.annotateLogs({
            receiptSchemaVersion: receipt.schemaVersion,
            evaluationSourceRevision: receipt.source.revision,
            evaluationImageRepository: receipt.source.image.repository,
            evaluationImageDigest: receipt.source.image.digest,
            restoreSourceRevision: receipt.restore.revision,
            restoreImageRepository: receipt.restore.image.repository,
            restoreImageDigest: receipt.restore.image.digest,
            targetClusterId: receipt.target.clusterId,
            targetLedger: receipt.target.ledger,
            runId: receipt.runId,
            qualification: receipt.qualification,
            accountCount: receipt.accountCount,
            transferCount: receipt.transferCount,
            exact: receipt.exact,
            planHash: receipt.planHash,
          }),
        ),
      ),
      Effect.provide(dependencies),
    )
  }),
)

const program = main.pipe(
  Effect.annotateLogs({ service: 'bayn', command: 'restore-ledger' }),
  Effect.provide(Logger.layer([Logger.consoleJson])),
)

NodeRuntime.runMain(program)
