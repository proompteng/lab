import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

interface Probe {
  readonly httpGet: { readonly path: string; readonly port: string }
  readonly initialDelaySeconds: number
  readonly periodSeconds: number
  readonly timeoutSeconds: number
  readonly failureThreshold: number
}

interface TempoValues {
  readonly liveStore: {
    readonly extraArgs?: readonly string[]
    readonly livenessProbe?: Probe
  }
}

const values = YAML.parse(
  readFileSync(
    new URL('../../../../../argocd/applications/observability/tempo-v3-values.yaml', import.meta.url),
    'utf8',
  ),
) as TempoValues

const durationSeconds = (flag: string): number => {
  const value = values.liveStore.extraArgs?.find((argument) => argument.startsWith(`${flag}=`))?.split('=')[1]
  const match = value?.match(/^(\d+)(s|m)$/)
  if (match === undefined || match === null) throw new Error(`Missing duration flag: ${flag}`)
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}

test('a failed Kafka reader is restarted before native catch-up readiness can time out', () => {
  expect(durationSeconds('-live-store.readiness-target-lag')).toBeGreaterThan(0)
  const nativeFallbackSeconds = durationSeconds('-live-store.readiness-max-wait')
  const probe = values.liveStore.livenessProbe
  if (probe === undefined) throw new Error('Live-store liveness recovery must have an explicit deadline')

  expect(probe.httpGet).toEqual({ path: '/ready', port: 'http-metrics' })
  expect(probe.failureThreshold).toBeGreaterThan(0)
  expect(probe.initialDelaySeconds).toBeGreaterThanOrEqual(60)
  const restartDeadlineSeconds =
    probe.initialDelaySeconds + probe.failureThreshold * (probe.periodSeconds + probe.timeoutSeconds)
  expect(restartDeadlineSeconds).toBeLessThan(nativeFallbackSeconds)
})
