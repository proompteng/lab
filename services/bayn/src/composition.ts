import { Effect, Layer } from 'effect'
import { NodeHttpClient, NodeServices } from '@effect/platform-node'

import type { ApplicationPlan } from './app'
import { runReadOnlyAutonomousStatusService } from './composition/read-only-status'
import { PostgresClientLive } from './db/postgres-client'
import { ExecutionControllerStatusStoreLive } from './db/execution-controller-status-postgres'
import { CycleObservabilityLive } from './cycle/store/observability'
import { JournalLive } from './ledger'
import { projectedReadLayer } from './broker/alpaca/session'
import { alpacaHttpLayer } from './broker/alpaca/http'
import { brokerSnapshotCacheConfig } from './broker/alpaca/snapshot-cache'
import { BrokerObservationsLive } from './db/broker-observations'
import { ValkeyCacheLive } from './valkey-cache'
import { HttpServerLive } from './http'

export const runApplicationPlan = (plan: ApplicationPlan) => {
  const postgres = PostgresClientLive(plan.config)
  const observations = Layer.unwrap(
    Effect.map(brokerSnapshotCacheConfig, (cache) =>
      BrokerObservationsLive(plan.config.alpaca.expectedAccountId, plan.config.build.sourceRevision, cache.maxAgeMs),
    ),
  )
  const resources = Layer.mergeAll(
    postgres,
    ExecutionControllerStatusStoreLive.pipe(Layer.provide(postgres)),
    CycleObservabilityLive.pipe(Layer.provide(postgres)),
    JournalLive(plan.config),
    projectedReadLayer(plan.config.alpaca).pipe(
      Layer.provide(alpacaHttpLayer(plan.config.alpaca)),
      Layer.provide(observations),
      Layer.provide(postgres),
    ),
  ).pipe(
    Layer.provideMerge(ValkeyCacheLive),
    Layer.provideMerge(Layer.mergeAll(HttpServerLive(plan.config), NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  )
  return Effect.scoped(
    Layer.build(resources).pipe(
      Effect.flatMap((context) => Effect.provide(runReadOnlyAutonomousStatusService(plan), context)),
    ),
  )
}
