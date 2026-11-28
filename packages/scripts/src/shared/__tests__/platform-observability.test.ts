import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { deployedMimirRules, mimirRuleGroup, observabilityDirectory } from './mimir-rules'

const root = resolve(import.meta.dir, '../../../../..')
const readValues = (name: string) =>
  YAML.parse(readFileSync(resolve(root, `argocd/applications/observability/${name}-values.yaml`), 'utf8'))

const tempo = readValues('tempo-v3')

test('Loki bounds push decoding and reserves a 2 MiB envelope for intact log records', () => {
  const values = readValues('loki-v3')
  expect(values.loki.distributor).toMatchObject({
    max_recv_msg_size: 8 * 1024 ** 2,
    max_decompressed_size: 16 * 1024 ** 2,
  })
  expect(values.loki.limits_config).toMatchObject({
    max_line_size: 2 * 1024 ** 2,
    max_line_size_truncate: false,
    allow_structured_metadata: false,
  })
  for (const component of ['distributor', 'querier', 'queryFrontend']) {
    expect(values[component]).toMatchObject({ replicas: 2, podDisruptionBudget: { maxUnavailable: 1 } })
  }
})

test('Mimir reserves ingester memory without imposing a hard cgroup cap or raising tenant limits', () => {
  const values = readValues('mimir')
  expect(values.ingester).toMatchObject({
    replicas: 3,
    resources: { requests: { cpu: '500m', memory: '2Gi' } },
    persistentVolume: { enabled: true, size: '20Gi', storageClass: 'rook-ceph-block' },
  })
  expect(values.ingester.resources.limits).toBeUndefined()
  expect(values.runtimeConfig.overrides.anonymous).toMatchObject({
    ingestion_rate: 20000,
    ingestion_burst_size: 400000,
    max_global_series_per_user: 300000,
  })
})

test.each([
  ['blockBuilder', '8Gi'],
  ['liveStore', '4Gi'],
] as const)(
  'Tempo gives %s memory headroom and reserves disk for local Kafka-derived working data',
  (component, disk) => {
    expect(tempo[component]).toMatchObject({
      replicas: 3,
      resources: {
        requests: { cpu: '200m', memory: '1Gi', 'ephemeral-storage': disk },
        limits: { cpu: 1, memory: '2Gi' },
      },
    })
  },
)

const runPromtool = (directory: string, ...args: string[]) => {
  const result = Bun.spawnSync([process.env.PROMTOOL ?? 'promtool', ...args], { cwd: directory })
  expect({ exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }).toEqual({
    exitCode: 0,
    output: expect.stringContaining('SUCCESS'),
  })
}

test('validates the full deployed Mimir rule file with native Prometheus', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'platform-promql-'))
  try {
    writeFileSync(resolve(directory, 'rules.yaml'), deployedMimirRules)
    runPromtool(directory, 'check', 'rules', 'rules.yaml')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

const readFixture = (name: string) => readFileSync(new URL(`tests/${name}`, observabilityDirectory), 'utf8')

const evaluateAlerts = (groups: ReturnType<typeof mimirRuleGroup>[], fixture: string) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'platform-promql-'))
  try {
    writeFileSync(resolve(directory, 'rules.yaml'), YAML.stringify({ groups }))
    writeFileSync(resolve(directory, 'tests.yaml'), fixture)
    runPromtool(directory, 'test', 'rules', 'tests.yaml')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test.each([
  ['agents-auto-ontology-alerts.yaml', ['agents-auto-ontology.rules']],
  ['agents-fleet-alerts.yaml', ['agents-fleet.rules']],
  ['bayn-backup-alerts.yaml', ['bayn-database-backup.rules']],
  ['flannel-cbr0-ipam-alerts.yaml', ['flannel-cbr0-ipam.rules']],
  ['platform-alerts.yaml', ['ofz-relay-platform.rules', 'tengri-production.rules']],
  ['restate-alerts.yaml', ['restate-control-plane.rules']],
] as const)('%s fires, clears, and detects missing observations', (fixture, groupNames) => {
  evaluateAlerts(groupNames.map(mimirRuleGroup), readFixture(fixture))
})

const torghutRegistryFixture = YAML.parse(readFixture('torghut-registry-alerts.yaml')) as {
  tests: { name: string }[]
}
const isMarketHoursCase = ({ name }: { name: string }) => name.startsWith('market-hours Kafka stall ')

test('Torghut WS and registry alerts fire, clear, and detect missing observations', () => {
  const tests = torghutRegistryFixture.tests.filter((scenario) => !isMarketHoursCase(scenario))
  expect(tests.length).toBeGreaterThan(0)
  evaluateAlerts(
    ['torghut-ws.rules', 'registry.rules'].map(mimirRuleGroup),
    YAML.stringify({ ...torghutRegistryFixture, tests }),
  )
})

test('Torghut WS Kafka stalls page during market hours only when the forwarder is ready', () => {
  const tests = torghutRegistryFixture.tests.filter(isMarketHoursCase)
  expect(tests.length).toBeGreaterThan(0)
  const group = mimirRuleGroup('torghut-ws.rules')
  const rule = group.rules.find(({ alert }) => alert === 'TorghutWSKafkaSendsStalledDuringMarketHours')
  if (!rule) throw new Error('Torghut WS market-hours stall alert is missing')
  // These cases span 14 hours and reference only this alert. Run the other rules in the shorter cases above.
  evaluateAlerts([{ ...group, rules: [rule] }], YAML.stringify({ ...torghutRegistryFixture, tests }))
})
