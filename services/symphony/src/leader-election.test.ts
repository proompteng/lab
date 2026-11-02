import { afterEach, describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { formatKubernetesMicroTime, LeaderElectionService, makeLeaderElectionLayer } from './leader-election'
import type { Logger } from './logger'

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
})

describe('leader election lease timestamp formatting', () => {
  test('formats Kubernetes MicroTime values with six fractional digits', () => {
    expect(formatKubernetesMicroTime(new Date('2026-03-15T00:16:00.123Z'))).toBe('2026-03-15T00:16:00.123000Z')
    expect(formatKubernetesMicroTime(new Date('2026-03-15T00:16:00.000Z'))).toBe('2026-03-15T00:16:00.000000Z')
  })
})

describe('leader election startup', () => {
  test('remains a follower when required service-account credentials are unavailable', async () => {
    process.env.KUBERNETES_SERVICE_HOST = 'kubernetes.default.svc'
    process.env.SYMPHONY_LEADER_ELECTION_ENABLED = 'true'
    process.env.SYMPHONY_LEADER_ELECTION_LEASE_NAMESPACE = 'symphony'

    const logger: Logger = {
      log: () => undefined,
      child: () => logger,
    }
    const layer = makeLeaderElectionLayer(logger, {
      readOptionalFile: () => Effect.succeed(null),
    })
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LeaderElectionService
        yield* service.start
        yield* Effect.sleep('10 millis')
        const snapshot = yield* service.status
        yield* service.stop
        return snapshot
      }).pipe(Effect.provide(layer)),
    )

    expect(status.required).toBe(true)
    expect(status.isLeader).toBe(false)
    expect(status.lastError).toBe(
      'leader election is enabled but Kubernetes service-account credentials are incomplete',
    )
  })
})
