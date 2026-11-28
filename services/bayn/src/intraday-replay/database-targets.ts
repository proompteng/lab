import { Effect, Redacted } from 'effect'
import type { ReplayDatabaseConfig } from './backtest'
import { ReplayBrokerFailure } from './broker'

export const validateReplayDatabaseTargets = (config: ReplayDatabaseConfig) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(Redacted.value(config.postgres.url)),
      catch: (cause) => new ReplayBrokerFailure({ message: 'Invalid replay database URL', cause }),
    })
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/\/(?:[a-z][a-z0-9_]*_)?(?:replay|test)$/.test(url.pathname) ||
      url.search !== '' ||
      url.hash !== '' ||
      config.tigerBeetle.replicaAddresses.length !== 1 ||
      !/^127\.0\.0\.1:\d+$/.test(config.tigerBeetle.replicaAddresses[0] ?? '') ||
      config.tigerBeetle.clusterId <= 0n ||
      config.tigerBeetle.ledger <= 0
    )
      return yield* new ReplayBrokerFailure({
        message: 'Replay requires explicitly named local replay/test PostgreSQL and local TigerBeetle targets',
      })
  })
