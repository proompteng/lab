import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'storage-csi-acceptance.sh')
const temporaryDirectories: string[] = []
const expectedImage = 'quay.io/cephcsi/cephcsi:v3.17.1'

type Scenario =
  | 'healthy'
  | 'approved-warning'
  | 'service-key-expired'
  | 'unknown-warning'
  | 'muted-warning'
  | 'health-mute'
  | 'quorum-bad'
  | 'osd-down'
  | 'pg-degraded'
  | 'csi-mismatch'
  | 'va-detached'
  | 'va-error'
  | 'va-deleting'
  | 'consumer-not-ready'

const fakeKubectlSource = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "__DOLLAR__*" >> "__DOLLAR__FAKE_KUBECTL_LOG"

if [[ "__DOLLAR__{1:-}" != "--context" || "__DOLLAR__{2:-}" != "__DOLLAR__FAKE_EXPECTED_CONTEXT" ]]; then
  echo "unexpected kube context: __DOLLAR__*" >&2
  exit 90
fi

if [[ "__DOLLAR__*" == *"ceph status -f json"* ]]; then
  cat "__DOLLAR__FAKE_HEALTH_JSON"
elif [[ "__DOLLAR__*" == *"ceph quorum_status -f json"* ]]; then
  cat "__DOLLAR__FAKE_QUORUM_JSON"
elif [[ "__DOLLAR__*" == *"ceph osd stat -f json"* ]]; then
  cat "__DOLLAR__FAKE_OSD_JSON"
elif [[ "__DOLLAR__*" == *"ceph pg stat -f json"* ]]; then
  cat "__DOLLAR__FAKE_PG_JSON"
elif [[ "__DOLLAR__*" == *"get cephcluster rook-ceph -o json"* ]]; then
  cat "__DOLLAR__FAKE_CLUSTER_JSON"
elif [[ "__DOLLAR__*" == *"get daemonset "* ]]; then
  cat "__DOLLAR__FAKE_DAEMONSET_JSON"
elif [[ "__DOLLAR__*" == *"get pods --all-namespaces"* ]]; then
  cat "__DOLLAR__FAKE_CONSUMER_PODS_JSON"
elif [[ "__DOLLAR__*" == *"get pods -l "* ]]; then
  cat "__DOLLAR__FAKE_NODE_PODS_JSON"
elif [[ "__DOLLAR__*" == *"get volumeattachments -o json"* ]]; then
  cat "__DOLLAR__FAKE_ATTACHMENTS_JSON"
elif [[ "__DOLLAR__*" == *"get pv -o json"* ]]; then
  cat "__DOLLAR__FAKE_PV_JSON"
else
  echo "unexpected kubectl call: __DOLLAR__*" >&2
  exit 93
fi
`.replaceAll('__DOLLAR__', '$')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

const writeJson = async (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')

const createFixture = async (
  scenario: Scenario,
): Promise<{ bin: string; log: string; files: Record<string, string> }> => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-csi-acceptance-'))
  temporaryDirectories.push(directory)
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  const fakeKubectl = join(bin, 'kubectl')
  await writeFile(fakeKubectl, fakeKubectlSource, 'utf8')
  await chmod(fakeKubectl, 0o755)

  const healthChecks = Object.fromEntries(
    [
      'AUTH_INSECURE_CLIENT_KEY_TYPE',
      'AUTH_INSECURE_KEYS_ALLOWED',
      'AUTH_INSECURE_KEYS_CREATABLE',
      'AUTH_INSECURE_ROTATING_SERVICE_KEY_TYPE',
    ].map((name) => [name, { muted: false, severity: 'HEALTH_WARN' }]),
  )
  const health =
    scenario === 'healthy' ||
    [
      'quorum-bad',
      'osd-down',
      'pg-degraded',
      'csi-mismatch',
      'va-detached',
      'va-error',
      'va-deleting',
      'consumer-not-ready',
    ].includes(scenario)
      ? { health: { checks: {}, mutes: [], status: 'HEALTH_OK' } }
      : { health: { checks: healthChecks, mutes: [], status: 'HEALTH_WARN' } }
  if (scenario === 'unknown-warning') {
    health.health.checks.UNKNOWN_WARNING = { muted: false, severity: 'HEALTH_WARN' }
  }
  if (scenario === 'muted-warning') {
    health.health.checks.AUTH_INSECURE_KEYS_ALLOWED.muted = true
  }
  if (scenario === 'health-mute') {
    health.health.mutes = ['AUTH_INSECURE_KEYS_ALLOWED']
  }
  if (scenario === 'service-key-expired') {
    delete health.health.checks.AUTH_INSECURE_ROTATING_SERVICE_KEY_TYPE
  }

  const cluster = {
    spec: { security: { cephx: { csi: { keyGeneration: 3, keyType: 'aes256k' } } } },
    status: {
      cephx: { csi: { keyGeneration: scenario === 'csi-mismatch' ? 2 : 3, keyType: 'aes256k' } },
      phase: 'Ready',
    },
  }
  const quorum =
    scenario === 'quorum-bad'
      ? { quorum: [0, 1], quorum_names: ['i', 'o'] }
      : { quorum: [0, 1, 2], quorum_names: ['i', 'o', 'p'] }
  const osd =
    scenario === 'osd-down'
      ? { num_in_osds: 6, num_osds: 6, num_up_osds: 5 }
      : { num_in_osds: 6, num_osds: 6, num_up_osds: 6 }
  const pg =
    scenario === 'pg-degraded'
      ? { pg_ready: true, pg_summary: { num_pg_by_state: [{ name: 'active+degraded', num: 2 }], num_pgs: 2 } }
      : { pg_ready: true, pg_summary: { num_pg_by_state: [{ name: 'active+clean', num: 2 }], num_pgs: 2 } }
  const daemonset = {
    spec: {
      selector: { matchLabels: { app: 'ceph-csi-node' } },
      updateStrategy: { rollingUpdate: { maxUnavailable: 1 }, type: 'RollingUpdate' },
    },
    status: {
      currentNumberScheduled: 1,
      desiredNumberScheduled: 1,
      numberAvailable: 1,
      numberReady: 1,
      updatedNumberScheduled: 1,
    },
  }
  const nodePods = {
    items: [
      {
        spec: { containers: [{ image: expectedImage }] },
        status: { conditions: [{ status: 'True', type: 'Ready' }], phase: 'Running' },
      },
    ],
  }
  const attachment = {
    metadata:
      scenario === 'va-deleting'
        ? { deletionTimestamp: '2026-01-01T00:00:00Z', name: 'csi-va-1' }
        : { name: 'csi-va-1' },
    spec: {
      attacher: 'rook-ceph.rbd.csi.ceph.com',
      nodeName: 'node-1',
      source: { persistentVolumeName: 'pv-1' },
    },
    status: {
      attachError: scenario === 'va-error' ? { message: 'synthetic attach failure' } : undefined,
      attached: scenario !== 'va-detached',
    },
  }
  const attachments = { items: [attachment] }
  const pvs = {
    items: [
      {
        spec: {
          claimRef: { name: 'claim-1', namespace: 'work' },
          csi: { driver: 'rook-ceph.rbd.csi.ceph.com' },
        },
      },
    ],
  }
  const consumerPods = {
    items: [
      {
        metadata: { name: 'consumer-1', namespace: 'work' },
        spec: { volumes: [{ persistentVolumeClaim: { claimName: 'claim-1' } }] },
        status:
          scenario === 'consumer-not-ready'
            ? { conditions: [{ status: 'False', type: 'Ready' }], phase: 'Pending' }
            : { conditions: [{ status: 'True', type: 'Ready' }], phase: 'Running' },
      },
    ],
  }

  const values = { attachments, cluster, consumerPods, daemonset, health, nodePods, osd, pg, pvs, quorum }
  const files: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    const path = join(directory, `${name}.json`)
    await writeJson(path, value)
    files[name] = path
  }
  const log = join(directory, 'kubectl.log')
  await writeFile(log, '', 'utf8')
  return { bin, files, log }
}

const runScript = (fixture: Awaited<ReturnType<typeof createFixture>>, args: string[] = []) => {
  const inheritedEnvironment = { ...process.env }
  delete inheritedEnvironment.KUBE_CONTEXT
  const environment = {
    ...inheritedEnvironment,
    FAKE_EXPECTED_CONTEXT: 'galactic-lan',
    FAKE_KUBECTL_LOG: fixture.log,
    PATH: `${fixture.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  }
  const environmentNames: Record<string, string> = {
    attachments: 'ATTACHMENTS',
    cluster: 'CLUSTER',
    consumerPods: 'CONSUMER_PODS',
    daemonset: 'DAEMONSET',
    health: 'HEALTH',
    nodePods: 'NODE_PODS',
    osd: 'OSD',
    pg: 'PG',
    pvs: 'PV',
    quorum: 'QUORUM',
  }
  for (const [name, path] of Object.entries(fixture.files)) {
    environment[`FAKE_${environmentNames[name]}_JSON`] = path
  }
  const result = Bun.spawnSync(['/bin/bash', script, ...args], {
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

test('strict mode completes functional evidence before rejecting approved security warnings', async () => {
  const fixture = await createFixture('approved-warning')
  const result = runScript(fixture)
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain('functional storage proof: PASS')
  expect(result.stderr).toContain('security completion: INCOMPLETE')
  const calls = (await readFile(fixture.log, 'utf8')).trim().split('\n').filter(Boolean)
  expect(calls.some((call) => call.includes('get volumeattachments'))).toBe(true)
  expect(calls.some((call) => call.includes('get pods --all-namespaces'))).toBe(true)
})

test('accepts an unchanged attachment baseline produced before the error check was added', async () => {
  const fixture = await createFixture('healthy')
  const priorCanonical =
    '[{"attached":true,"deleting":null,"name":"csi-va-1","node":"node-1","persistentVolume":"pv-1"}]\n'
  const digest = createHash('sha256').update(priorCanonical).digest('hex')
  const baseline = join(fixture.bin, 'previous-baseline.sha256')
  await writeFile(baseline, `${digest}\n`)
  const result = runScript(fixture, ['--baseline', baseline])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(`attachmentDigest=${digest}`)
})

test.each(['approved-warning', 'service-key-expired'] as const)(
  'functional-only accepts known transitional warnings for %s and reports security incomplete',
  async (scenario) => {
    const fixture = await createFixture(scenario)
    const result = runScript(fixture, ['--functional-only'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('functional storage proof: PASS')
    expect(result.stdout).toContain('security completion: INCOMPLETE')
    expect(result.stdout).toContain('CSI node-plugin acceptance: PASS')
  },
)

test('strict HEALTH_OK completes acceptance', async () => {
  const fixture = await createFixture('healthy')
  const result = runScript(fixture)
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('security completion: PASS')
  expect(result.stdout).toContain('CSI node-plugin acceptance: PASS')
})

test.each([
  ['unknown-warning', 'storage CSI acceptance: FAIL'],
  ['muted-warning', 'storage CSI acceptance: FAIL'],
  ['health-mute', 'storage CSI acceptance: FAIL'],
  ['quorum-bad', 'monitor quorum'],
  ['osd-down', 'OSD health'],
  ['pg-degraded', 'PGs'],
  ['csi-mismatch', 'CephCluster'],
  ['va-detached', 'VolumeAttachment'],
  ['va-error', 'VolumeAttachment'],
  ['va-deleting', 'VolumeAttachment'],
  ['consumer-not-ready', 'storage consumers'],
] as const)('functional-only fails closed for %s', async (scenario, expectedMessage) => {
  const fixture = await createFixture(scenario)
  const result = runScript(fixture, ['--functional-only'])
  expect(result.exitCode).toBe(1)
  expect(`${result.stdout}\n${result.stderr}`).toContain(expectedMessage)
})
