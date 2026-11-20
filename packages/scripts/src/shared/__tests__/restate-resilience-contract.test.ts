import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'
import { matchesPaths } from '../../ci/affected-inputs'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Restate image promotion requires native build proofs and uploaded release evidence', () => {
  const workflow = YAML.parse(readRepoFile('.github/workflows/restate-images.yml'))
  const build = workflow.jobs.build
  const publish = workflow.jobs.publish
  const mainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(workflow.on.pull_request.paths).toEqual([
    '.github/actions/affected-inputs/**',
    'packages/scripts/src/ci/**',
    ...workflow.on.push.paths,
  ])
  expect(build.needs).toBe('changes')
  expect(build.if).toBe("needs.changes.outputs.changed == 'true' && needs.changes.outputs.reuse != 'true'")
  expect(build.strategy.matrix.include.map((entry: { architecture: string }) => entry.architecture).sort()).toEqual([
    'amd64',
    'arm64',
  ])
  const runtime = build.steps.find((step: { name?: string }) => step.name === 'Build runtime')
  expect(runtime.with.push).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}")
  expect(runtime.with.load).toBeUndefined()
  expect(workflow.on.push.paths).not.toContain('packages/scripts/src/shared/cli.ts')
  expect(workflow.on.push.paths).not.toContain('packages/scripts/src/shared/docker.ts')
  expect(publish.if).toContain(mainOnly)
  expect(publish.if).toContain('!cancelled()')
  expect(publish.if).toContain("needs.changes.result == 'success'")
  expect(publish.if).toContain("needs.build.result == 'success'")
  expect(publish.if).toContain("needs.build.result == 'skipped' && needs.changes.outputs.reuse == 'true'")
  expect(publish.needs).toEqual(['changes', 'build', 'cache-proof'])
  const releaseSteps = publish.steps as { name?: string; uses?: string }[]
  const uploaded = releaseSteps.findIndex((step) => step.uses === 'actions/upload-artifact@v4')
  expect(uploaded).toBeGreaterThan(0)
  expect(releaseSteps.findIndex((step) => step.name === 'Expose the validated digest to Kargo')).toBeGreaterThan(
    uploaded,
  )
  expect(publish.steps.at(-1).run).toContain('test "$existing" = "$DIGEST"')

  const warehouses = YAML.parseAllDocuments(readRepoFile('argocd/applications/kargo/warehouses.yaml')).map((document) =>
    document.toJSON(),
  )
  const warehouse = warehouses.find((entry) => entry.metadata.name === 'restate')
  expect(warehouse.spec.subscriptions[0].git.includePaths).toEqual(
    workflow.on.push.paths.map((path: string) => path.replace(/\/\*\*$/, '')),
  )
  const stages = YAML.parseAllDocuments(readRepoFile('argocd/applications/kargo/stages.yaml')).map((document) =>
    document.toJSON(),
  )
  const stage = stages.find((entry) => entry.metadata.name === 'restate')
  expect(
    stage.spec.promotionTemplate.spec.steps.find((step: { uses: string }) => step.uses === 'kustomize-set-image')
      .config,
  ).toEqual({
    path: './out/argocd/applications/restate',
    images: [
      { image: 'restate-runtime', newName: '${{ vars.imageRepo }}', digest: '${{ imageFrom(vars.imageRepo).Digest }}' },
    ],
  })
})

test.each([
  ['bun.lock', false],
  ['services/jangar/package.json', false],
  ['packages/scripts/src/shared/docker.ts', false],
  ['packages/scripts/src/restate/release-inputs.ts', true],
  ['.github/workflows/restate-images.yml', true],
  ['argocd/applicationsets/platform.yaml', false],
  ['services/restate/Dockerfile', true],
  ['services/restate/metadata-background.patch', true],
  ['argocd/applications/restate/statefulset.yaml', true],
] as const)('Restate publication input %s is affected=%s', (path, affected) => {
  const workflow = YAML.parse(readRepoFile('.github/workflows/restate-images.yml'))
  expect(matchesPaths(path, workflow.on.push.paths)).toBe(affected)
})

test('Restate 1.8.1 preserves retained HA state while Kargo owns runtime image selection', () => {
  const statefulSet = YAML.parse(readRepoFile('argocd/applications/restate/statefulset.yaml')) as Record<string, any>
  const env = new Map(
    statefulSet.spec.template.spec.containers[0].env.map((entry: { name: string; value?: string }) => [
      entry.name,
      entry.value,
    ]),
  )

  expect(statefulSet.spec.replicas).toBe(3)
  expect(statefulSet.spec.template.spec.containers[0].image).toBe('restate-runtime')
  const kustomization = YAML.parse(readRepoFile('argocd/applications/restate/kustomization.yaml'))
  expect(kustomization.images).toEqual([
    {
      name: 'restate-runtime',
      newName: 'docker.restate.dev/restatedev/restate',
      newTag: '1.8.1',
      digest: 'sha256:cd5ee1abb1b3f91e813e327a024779280938aaff991ccdc5b241a3a3a4bddce1',
    },
  ])
  expect(env.get('RESTATE_METADATA_SERVER__RAFT_ELECTION_TICK')).toBe('450')
  expect(env.get('RESTATE_GOSSIP_FAILURE_THRESHOLD')).toBe('450')
  expect(env.get('RESTATE_GOSSIP_LONELINESS_THRESHOLD')).toBe('600')
  expect(env.get('RESTATE_GOSSIP_TIME_SKEW_THRESHOLD')).toBe('5s')
  expect(env.get('RESTATE_NETWORKING__CONNECT_TIMEOUT')).toBe('10s')
  expect(env.get('RESTATE_NETWORKING__HANDSHAKE_TIMEOUT')).toBe('10s')
  expect(env.get('RESTATE_NETWORKING__HTTP2_KEEP_ALIVE_TIMEOUT')).toBe('10s')
  expect(env.get('RESTATE_METADATA_CLIENT__CONNECT_TIMEOUT')).toBe('10s')
  expect(env.get('RESTATE_METADATA_CLIENT__KEEP_ALIVE_TIMEOUT')).toBe('10s')
  expect(env.get('RESTATE_LOG_SERVER__ALWAYS_COMMIT_IN_BACKGROUND')).toBe('true')
  expect(env.get('RESTATE_WORKER__STORAGE__ALWAYS_COMMIT_IN_BACKGROUND')).toBe('true')
  expect(env.has('RESTATE_TRACING_FILTER')).toBe(false)
  expect(statefulSet.spec.template.spec.terminationGracePeriodSeconds).toBe(90)
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].topologyKey).toBe('kubernetes.io/hostname')
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].whenUnsatisfiable).toBe('ScheduleAnyway')
  expect(
    statefulSet.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution,
  ).toEqual([{ labelSelector: { matchLabels: { app: 'restate' } }, topologyKey: 'kubernetes.io/hostname' }])
  expect(
    statefulSet.spec.template.spec.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution,
  ).toBeUndefined()
  expect(env.get('RESTATE_AUTO_PROVISION')).toBe('false')
  expect(env.get('RESTATE_METADATA_CLIENT__ADDRESSES')).toBe(
    '["http://restate-0.restate-cluster:5122","http://restate-1.restate-cluster:5122","http://restate-2.restate-cluster:5122"]',
  )
  expect(env.get('RESTATE_DEFAULT_REPLICATION')).toBe('2')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__DESTINATION')).toBe('s3://restate-snapshots/partitions')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__SNAPSHOT_INTERVAL')).toBe('30m')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__NUM_RETAINED')).toBe('2')
  expect(statefulSet.spec.template.spec.initContainers).toBeUndefined()
})

test('Restate uses generic NVMe claims and native worker roles', () => {
  const statefulSet = YAML.parse(readRepoFile('argocd/applications/restate/statefulset.yaml'))
  const spec = statefulSet.spec.template.spec
  expect(statefulSet.spec.updateStrategy).toEqual({ type: 'RollingUpdate' })
  expect(statefulSet.spec.volumeClaimTemplates[0].spec.storageClassName).toBe('local-path')
  expect(statefulSet.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe('16Gi')
  expect(spec.schedulingGates).toBeUndefined()
  expect(spec.tolerations).toEqual([
    {
      key: 'workload.proompteng.ai/compute-local',
      operator: 'Equal',
      value: 'true',
      effect: 'NoSchedule',
    },
  ])
  const roles = YAML.parse(readRepoFile('argocd/applications/restate/node-roles-configmap.yaml')).data
  expect(roles['node-0.toml']).toContain('"worker"')
  expect(roles['node-1.toml']).not.toContain('"worker"')
  expect(roles['node-2.toml']).toContain('"worker"')
  const env = spec.containers[0].env
  expect(env.find((entry: { name: string }) => entry.name === 'POD_INDEX').valueFrom.fieldRef.fieldPath).toBe(
    "metadata.labels['apps.kubernetes.io/pod-index']",
  )
  expect(env.find((entry: { name: string }) => entry.name === 'RESTATE_CONFIG').value).toBe(
    '/etc/restate/node-$(POD_INDEX).toml',
  )
})

test('Restate retains RGW snapshots without bootstrap or singleton migration jobs', () => {
  const obc = YAML.parse(readRepoFile('argocd/applications/restate/objectbucketclaim.yaml'))
  const resources = YAML.parse(readRepoFile('argocd/applications/restate/kustomization.yaml')).resources
  expect(obc.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(obc.spec).toEqual({ bucketName: 'restate-snapshots', storageClassName: 'rook-ceph-bucket' })
  expect(resources).toContain('objectbucketclaim.yaml')
  expect(resources).not.toContain('singleton-rollback-guard.yaml')
  expect(resources).not.toContain('snapshot-bootstrap-job.yaml')
  expect(resources).not.toContain('replication-migration-job.yaml')
})

test('Restate admin exposure remains tailnet-restricted', () => {
  const networkPolicy = readRepoFile('argocd/applications/restate/networkpolicy.yaml')
  const ingress = readRepoFile('argocd/applications/restate/admin-tailscale-ingress.yaml')
  const service = readRepoFile('argocd/applications/restate/service.yaml')

  expect(networkPolicy).toContain('tailscale.com/parent-resource: restate-admin-tailscale')
  expect(networkPolicy).toContain('port: admin')
  expect(ingress).toContain('restate.ide-newton.ts.net')
  expect(ingress).toContain('name: admin')
  expect(service).toContain('port: 9070')
})

test('Restate resilience telemetry scrapes every node and retains snapshot recovery evidence', () => {
  const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const rules = readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')
  const rulesConfig = YAML.parse(rules) as { data: Record<string, string> }
  const ruleGroups = YAML.parse(rulesConfig.data['graf-rules.yaml']) as {
    groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; for?: string }> }>
  }
  const restateRules = ruleGroups.groups.find((group) => group.name === 'restate-control-plane.rules')?.rules ?? []
  const restoreNeverSucceeded = restateRules.find((rule) => rule.alert === 'RestateSnapshotRestoreDrillNeverSucceeded')
  const snapshotStale = restateRules.find((rule) => rule.alert === 'RestateSnapshotStale')
  const snapshotUploadFailure = restateRules.find((rule) => rule.alert === 'RestateSnapshotUploadFailure')

  for (const ordinal of [0, 1, 2]) {
    expect(alloy).toContain(`restate-${ordinal}.restate-cluster.restate.svc.cluster.local:5122`)
  }
  expect(rules).toContain('sum(up{job="restate-server", namespace="restate", service="restate"}) < 3')
  expect(rules).toContain('restate_partition_snapshot_age_seconds')
  expect(rules).toContain('restate_partition_store_snapshots_upload_failed_total')
  expect(rules).not.toContain('RestatePartitionBacklog')
  expect(rules).not.toContain('RestateControlPlaneAuditStale')
  expect(restoreNeverSucceeded?.expr).toContain('absent(kube_cronjob_created')
  expect(snapshotStale?.expr).toContain('max by (namespace, service)')
  expect(snapshotStale?.expr).toContain('min by (namespace, service, partition)')
  expect(snapshotStale?.expr).not.toContain('max by (namespace, service) (\n  restate_partition_snapshot_age_seconds')
  expect(snapshotUploadFailure?.expr).toContain('sum by (namespace, service)')
  expect(snapshotUploadFailure?.expr).toContain('namespace="restate"')
  expect(snapshotUploadFailure?.expr).not.toContain('instance')
})

test('Restate recovery proof opens all snapshots offline without exposing OBC credentials', () => {
  const proof = readRepoFile('argocd/applications/restate/snapshot-restore-proof-job.yaml')
  const drill = readRepoFile('argocd/applications/restate/snapshot-restore-drill-cronjob.yaml')
  const scripts = readRepoFile('argocd/applications/restate/resilience-scripts-configmap.yaml')
  const kustomization = readRepoFile('argocd/applications/restate/kustomization.yaml')
  expect(YAML.parse(proof).spec.template.spec.containers[0].image).toBe('restate-runtime')
  expect(YAML.parse(drill).spec.jobTemplate.spec.template.spec.containers[0].image).toBe('restate-runtime')
  const dockerfile = readRepoFile('services/restate/Dockerfile')
  expect(dockerfile).toContain('cargo build --locked --release -p restate-doctor')
  expect(dockerfile).toContain('COPY --from=builder /tmp/restate-doctor /usr/local/bin/restate-doctor')
  expect(proof).toContain('secretKeyRef:')
  expect(proof).not.toContain('--aws-access-key-id')
  expect(proof).not.toContain('--aws-secret-access-key')
  expect(scripts).toContain('restate-doctor snapshot s3://restate-snapshots/partitions')
  expect(scripts).toContain("grep -Fq 'Found 24 partition(s):'")
  expect(scripts).toContain("grep -Fqi 'invocation_rows'")
  expect(scripts).toContain('while [ "$SECONDS" -lt 1680 ]')
  expect(scripts).toContain('Snapshot repository is not complete yet; retrying isolated restore proof')
  expect(proof).toContain('emptyDir: {}')
  expect(proof).toContain('memory: 4096Mi')
  expect(drill).toContain('memory: 4096Mi')
  expect(drill).toContain('schedule: "17 6 * * *"')
  expect(kustomization).toContain('- snapshot-restore-proof-job.yaml')
  expect(kustomization).toContain('- snapshot-restore-drill-cronjob.yaml')
})

test('Restate recovery proof never accepts success markers from a failed doctor command', () => {
  const configMap = YAML.parse(readRepoFile('argocd/applications/restate/resilience-scripts-configmap.yaml')) as {
    data: Record<string, string>
  }
  const script = configMap.data['snapshot-restore.sh']
  const tempDir = mkdtempSync('/tmp/restate-restore-status-')
  const doctor = `${tempDir}/restate-doctor`
  const sleep = `${tempDir}/sleep`
  const attempts = `${tempDir}/attempts`

  try {
    writeFileSync(
      doctor,
      `#!/bin/sh
set -eu
n=$(cat "${attempts}" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" >"${attempts}"
echo 'Found 24 partition(s): 0-23'
echo 'INVOCATION_ROWS'
[ "$n" -gt 1 ] || exit 17
`,
    )
    writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
    chmodSync(doctor, 0o755)
    chmodSync(sleep, 0o755)

    const result = Bun.spawnSync(['/bin/bash', '-ceu', script], {
      env: { ...process.env, AWS_REGION: 'us-east-1', PATH: `${tempDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(attempts, 'utf8').trim()).toBe('2')
    expect(result.stderr.toString()).toContain(
      'Snapshot repository is not complete yet; retrying isolated restore proof',
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

const activePartition = {
  generation: 'N1:91',
  state: 'alive',
  has_worker_role: true,
  worker_state: 'active',
  partition_id: 0,
  membership: 'current',
  replay_status: 'active',
  updated_at: '2026-11-08T23:00:00.000',
}
const advancingPartition = { ...activePartition, updated_at: '2026-11-08T23:00:02.000' }
const unassignedWorker = {
  ...activePartition,
  partition_id: null,
  membership: null,
  replay_status: null,
  updated_at: null,
}

test.each([
  { name: 'active and advancing', first: [activePartition], second: [advancingPartition], succeeds: true },
  {
    name: 'non-worker member has no assignments',
    first: [{ ...unassignedWorker, has_worker_role: false, worker_state: null }],
    second: [{ ...unassignedWorker, has_worker_role: false, worker_state: null }],
    succeeds: true,
  },
  {
    name: 'non-worker still has assignments',
    first: [{ ...activePartition, has_worker_role: false }],
    succeeds: false,
  },
  {
    name: 'role changes during recovery check',
    first: [{ ...unassignedWorker, has_worker_role: false, worker_state: null }],
    second: [{ ...unassignedWorker, worker_state: 'disabled' }],
    succeeds: false,
  },
  { name: 'empty assignments', first: [], second: [], succeeds: false },
  { name: 'missing processor', first: [{ ...activePartition, replay_status: null }], succeeds: false },
  { name: 'still catching up', first: [{ ...activePartition, replay_status: 'catching-up' }], succeeds: false },
  { name: 'next assignment', first: [{ ...activePartition, membership: 'next' }], succeeds: false },
  { name: 'dead member', first: [{ ...activePartition, state: 'dead' }], succeeds: false },
  { name: 'no partition', first: [{ ...activePartition, partition_id: null }], succeeds: false },
  ...['draining', 'disabled', 'provisioning'].map((worker_state) => ({
    name: `${worker_state} worker without assignments is not recovered`,
    first: [{ ...unassignedWorker, worker_state }],
    second: [{ ...unassignedWorker, worker_state }],
    succeeds: false,
  })),
  {
    name: 'draining member still has assignments',
    first: [{ ...activePartition, worker_state: 'draining' }],
    succeeds: false,
  },
  {
    name: 'member activates without assignments',
    first: [{ ...unassignedWorker, worker_state: 'draining' }],
    second: [unassignedWorker],
    succeeds: false,
  },
  { name: 'stale status', first: [activePartition], second: [activePartition], succeeds: false },
  {
    name: 'new generation during check',
    first: [activePartition],
    second: [{ ...advancingPartition, generation: 'N1:92' }],
    succeeds: false,
  },
  { name: 'lost assignments', first: [activePartition], second: [], succeeds: false },
  {
    name: 'one processor stops progressing',
    first: [activePartition, { ...activePartition, partition_id: 1 }],
    second: [advancingPartition, { ...activePartition, partition_id: 1 }],
    succeeds: false,
  },
  { name: 'query failure', first: [activePartition], queryFails: true, succeeds: false },
])('Restate startup recovery rejects incomplete state: $name', (scenario) => {
  const configMap = YAML.parse(readRepoFile('argocd/applications/restate/resilience-scripts-configmap.yaml'))
  const statefulSet = YAML.parse(readRepoFile('argocd/applications/restate/statefulset.yaml'))
  expect(statefulSet.spec.template.spec.containers[0].startupProbe.exec.command).toEqual([
    '/bin/bash',
    '/opt/restate-resilience/partition-startup.sh',
  ])
  const tempDir = mkdtempSync('/tmp/restate-startup-')
  try {
    writeFileSync(`${tempDir}/first.json`, JSON.stringify(scenario.first))
    writeFileSync(`${tempDir}/second.json`, JSON.stringify(scenario.second ?? []))
    writeFileSync(
      `${tempDir}/restatectl`,
      '#!/bin/sh\nset -eu\n[ "$QUERY_FAILS" != true ] || exit 17\n' +
        'if [ -f "$FIXTURE_DIR/read" ]; then cat "$FIXTURE_DIR/second.json"; else\n' +
        'touch "$FIXTURE_DIR/read"; cat "$FIXTURE_DIR/first.json"; fi\n',
    )
    writeFileSync(`${tempDir}/sleep`, '#!/bin/sh\nexit 0\n')
    chmodSync(`${tempDir}/restatectl`, 0o755)
    chmodSync(`${tempDir}/sleep`, 0o755)
    const result = Bun.spawnSync(['/bin/bash', '-ceu', configMap.data['partition-startup.sh']], {
      env: {
        ...process.env,
        POD_NAME: 'restate-0',
        FIXTURE_DIR: tempDir,
        QUERY_FAILS: String(scenario.queryFails ?? false),
        PATH: `${tempDir}:${process.env.PATH ?? ''}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode === 0).toBe(scenario.succeeds)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
