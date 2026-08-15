import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { expect, test } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

test('Restate cluster uses three stable 1.7.2 nodes with hard host separation', () => {
  const statefulSet = YAML.parse(readRepoFile('argocd/applications/restate/statefulset.yaml')) as Record<string, any>
  const env = new Map(
    statefulSet.spec.template.spec.containers[0].env.map((entry: { name: string; value?: string }) => [
      entry.name,
      entry.value,
    ]),
  )

  expect(statefulSet.spec.replicas).toBe(3)
  expect(statefulSet.spec.template.spec.containers[0].image).toBe('docker.restate.dev/restatedev/restate:1.7.2')
  expect(statefulSet.spec.template.spec.terminationGracePeriodSeconds).toBe(90)
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].topologyKey).toBe('kubernetes.io/hostname')
  expect(statefulSet.spec.template.spec.topologySpreadConstraints[0].whenUnsatisfiable).toBe('DoNotSchedule')
  expect(
    statefulSet.spec.template.spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution,
  ).toHaveLength(1)
  expect(env.get('RESTATE_AUTO_PROVISION')).toBe('false')
  expect(env.get('RESTATE_METADATA_CLIENT__ADDRESSES')).toBe(
    '["http://restate-0.restate-cluster:5122","http://restate-1.restate-cluster:5122","http://restate-2.restate-cluster:5122"]',
  )
  expect(env.get('RESTATE_DEFAULT_REPLICATION')).toBe('1')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__DESTINATION')).toBe('s3://restate-snapshots/partitions')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__SNAPSHOT_INTERVAL')).toBe('30m')
  expect(env.get('RESTATE_WORKER__SNAPSHOTS__NUM_RETAINED')).toBe('2')
})

test('Restate HA migration preserves quorum and changes existing replication only after membership converges', () => {
  const pdb = readRepoFile('argocd/applications/restate/poddisruptionbudget.yaml')
  const migration = readRepoFile('argocd/applications/restate/replication-migration-job.yaml')
  const kustomization = readRepoFile('argocd/applications/restate/kustomization.yaml')

  expect(pdb).toContain('minAvailable: 3')
  expect(migration).toContain('metadata-server list')
  expect(migration).toContain('rows == 3 && bad == 0')
  expect(migration).toContain('expected_set[expected_ids[i]] = 1')
  expect(migration).toContain('if (!(actual[i] in expected_set)) bad += 1')
  expect(migration).toContain('config set --replication 2')
  expect(migration).toContain('logs_replication_ready')
  expect(migration).toContain('logs describe --all --extra "$id"')
  expect(migration).toContain('last_replicated ~ /\\{node: 2\\}/')
  expect(migration).toContain('rows != 48')
  expect(migration).toContain('if nodes_ready && \\')
  expect(migration).toContain('docker.restate.dev/restatedev/restate:1.7.2')
  expect(migration).toContain('activeDeadlineSeconds: 1500')
  expect(migration).toContain('nodes set-storage-state --nodes "$id" --storage-state read-write')
  expect(migration).toContain('nodes set-worker-state --nodes "$id" --worker-state active')
  expect(migration).toContain('metadata-server add-node "$id"')
  expect(migration).toContain('$8 !~ /^[1-9][0-9]*$/')
  expect(migration).not.toContain('kubectl')
  expect(kustomization).toContain('- poddisruptionbudget.yaml')
  expect(kustomization).toContain('- replication-migration-job.yaml')
  expect(kustomization).not.toContain('- singleton-rollback-guard.yaml')
})

test('Restate replication migration accepts a sealed log only after its latest replicated segment reaches two', () => {
  const migration = YAML.parse(readRepoFile('argocd/applications/restate/replication-migration-job.yaml')) as Record<
    string,
    any
  >
  const script = migration.spec.template.spec.containers[0].command[2] as string
  const start = script.indexOf('logs_replication_ready() {')
  const end = script.indexOf('\n\nfor attempt in $(seq 1 60); do', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const functionBody = script.slice(start, end)
  const tempDir = mkdtempSync('/tmp/restate-sealed-log-')
  const restatectl = `${tempDir}/restatectl`

  try {
    writeFileSync(
      restatectl,
      `#!/bin/sh
set -eu
case " $* " in
  *" logs list "*)
    i=0
    while [ "$i" -lt 24 ]; do
      if [ "$i" -eq 1 ]; then
        echo '1 4 202 sealed N/A N/A N/A N/A'
      else
        echo "$i 4 202 replicated \${i}_8 {node: 2} N1:6 [N1,N2,N3]"
      fi
      i=$((i + 1))
    done
    ;;
  *" logs describe --all --extra 1 "*)
    cat <<OUT
3 142 replicated 1_3 {node: 1} N1:5 [N1]
5 201 replicated 1_5 {node: \${SEALED_REPLICATION:-2}} N1:6 [N1,N2,N3]
▶︎ 5 202 sealed
OUT
    ;;
  *) echo "unexpected restatectl invocation: $*" >&2; exit 90 ;;
esac
`,
    )
    chmodSync(restatectl, 0o755)

    const run = (sealedReplication: string) =>
      Bun.spawnSync(['/bin/bash', '-ceu', `address=http://restate-0\n${functionBody}\nlogs_replication_ready`], {
        env: { ...process.env, PATH: `${tempDir}:${process.env.PATH ?? ''}`, SEALED_REPLICATION: sealedReplication },
        stdout: 'pipe',
        stderr: 'pipe',
      })

    expect(run('2').exitCode).toBe(0)
    expect(run('1').exitCode).not.toBe(0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Restate replication migration treats archived LSN zero as no snapshot and never mutates replication', () => {
  const migration = YAML.parse(readRepoFile('argocd/applications/restate/replication-migration-job.yaml')) as Record<
    string,
    any
  >
  const script = migration.spec.template.spec.containers[0].command[2] as string
  const tempDir = mkdtempSync('/tmp/restate-invalid-archive-')
  const mutationMarker = `${tempDir}/replication-mutated`
  const restatectl = `${tempDir}/restatectl`
  const sleep = `${tempDir}/sleep`

  try {
    writeFileSync(
      restatectl,
      `#!/bin/sh
set -eu
case " $* " in
  *" nodes list --extra "*)
    cat <<'OUT'
N1 6 restate-0 http://restate-0 roles read-write active x Alive Ready Ready Ready Member
N2 1 restate-2 http://restate-2 roles read-write active x Alive Ready Ready Ready Member
N3 1 restate-1 http://restate-1 roles read-write active x Alive Ready Ready Ready Member
OUT
    ;;
  *" metadata-server add-node "*) exit 0 ;;
  *" metadata-server list "*)
    cat <<'OUT'
N1 Member v3 N1 [N1,N2,N3] 10 10 1 1 1 1
N2 Member v3 N1 [N1,N2,N3] 10 10 1 1 1 1
N3 Member v3 N1 [N1,N2,N3] 10 10 1 1 1 1
OUT
    ;;
  *" partitions list "*)
    i=0
    while [ "$i" -lt 24 ]; do
      archived=100
      [ "$i" -ne 0 ] || archived=0
      echo "$i N1:6 Leader Active e6 100 100 $archived 0 1 v62 - journal_v2 now"
      i=$((i + 1))
    done
    ;;
  *" config set --replication 2 "*) touch "${mutationMarker}" ;;
  *) echo "unexpected restatectl invocation: $*" >&2; exit 90 ;;
esac
`,
    )
    writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
    chmodSync(restatectl, 0o755)
    chmodSync(sleep, 0o755)

    const result = Bun.spawnSync(['/bin/bash', '-ceu', script], {
      env: { ...process.env, PATH: `${tempDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Three-node Restate membership did not converge safely')
    expect(Bun.file(mutationMarker).size).toBe(0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Restate replication migration refuses to mutate when any one node is not fully ready', () => {
  const migration = YAML.parse(readRepoFile('argocd/applications/restate/replication-migration-job.yaml')) as Record<
    string,
    any
  >
  const script = migration.spec.template.spec.containers[0].command[2] as string
  const tempDir = mkdtempSync('/tmp/restate-replication-readiness-')
  const mutationMarker = `${tempDir}/replication-mutated`
  const restatectl = `${tempDir}/restatectl`
  const sleep = `${tempDir}/sleep`

  try {
    writeFileSync(
      restatectl,
      `#!/bin/sh
set -eu
case " $* " in
  *" nodes list --extra "*)
    cat <<'OUT'
N1 5 restate-0 http://restate-0 Alive Ready Ready Ready Member
N2 1 restate-1 http://restate-1 Alive Ready Ready Starting Member
N3 1 restate-2 http://restate-2 Alive Ready Ready Ready Member
OUT
    ;;
  *" config set --replication 2 "*)
    touch "${mutationMarker}"
    ;;
  *)
    echo "unexpected restatectl invocation: $*" >&2
    exit 90
    ;;
esac
`,
    )
    writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
    chmodSync(restatectl, 0o755)
    chmodSync(sleep, 0o755)

    const result = Bun.spawnSync(['/bin/bash', '-ceu', script], {
      env: { ...process.env, PATH: `${tempDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('Three-node Restate membership did not converge safely')
    expect(Bun.file(mutationMarker).size).toBe(0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Restate HA migration reactivates the exact retained nodes after singleton rollback', () => {
  const migration = YAML.parse(readRepoFile('argocd/applications/restate/replication-migration-job.yaml')) as Record<
    string,
    any
  >
  const script = migration.spec.template.spec.containers[0].command[2] as string
  const start = script.indexOf('reactivate_retained_nodes() {')
  const end = script.indexOf('\n\nmetadata_quorum_ready() {')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const functionBody = script.slice(start, end)
  const tempDir = mkdtempSync('/tmp/restate-retained-reactivation-')
  const restatectl = `${tempDir}/restatectl`
  const calls = `${tempDir}/calls`

  try {
    writeFileSync(
      restatectl,
      `#!/bin/sh
set -eu
case " $* " in
  *" nodes list --extra "*)
    cat <<'OUT'
N1 5 restate-0 http://restate-0 roles read-write active Alive Ready Ready Ready Member
N2 1 restate-1 http://restate-1 roles read-only draining Alive Ready Ready Ready Standby
N3 1 restate-2 http://restate-2 roles read-only draining Alive Ready Ready Ready Standby
OUT
    ;;
  *" nodes set-storage-state "*) printf 'storage:%s\n' "$*" >>"${calls}" ;;
  *" nodes set-worker-state "*) printf 'worker:%s\n' "$*" >>"${calls}" ;;
  *" metadata-server add-node "*) printf 'metadata:%s\n' "$*" >>"${calls}" ;;
  *) echo "unexpected restatectl invocation: $*" >&2; exit 90 ;;
esac
`,
    )
    chmodSync(restatectl, 0o755)

    const result = Bun.spawnSync(
      ['/bin/bash', '-ceu', `address=http://restate-0\n${functionBody}\nreactivate_retained_nodes`],
      {
        env: { ...process.env, PATH: `${tempDir}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    expect(result.exitCode).toBe(0)
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'storage:--yes --address http://restate-0 nodes set-storage-state --nodes N2 --storage-state read-write',
      'worker:--yes --address http://restate-0 nodes set-worker-state --nodes N2 --worker-state active',
      'metadata:--yes --address http://restate-0 metadata-server add-node N2',
      'storage:--yes --address http://restate-0 nodes set-storage-state --nodes N3 --storage-state read-write',
      'worker:--yes --address http://restate-0 nodes set-worker-state --nodes N3 --worker-state active',
      'metadata:--yes --address http://restate-0 metadata-server add-node N3',
    ])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Restate snapshots use the existing Rook OBC contract and block rollout until all partitions are archived', () => {
  const obc = YAML.parse(readRepoFile('argocd/applications/restate/objectbucketclaim.yaml')) as Record<string, any>
  const bootstrap = readRepoFile('argocd/applications/restate/snapshot-bootstrap-job.yaml')
  const rollback = readRepoFile('argocd/applications/restate/singleton-rollback-guard.yaml')
  const kustomization = readRepoFile('argocd/applications/restate/kustomization.yaml')

  expect(obc.metadata.annotations['argocd.argoproj.io/sync-wave']).toBe('-1')
  expect(obc.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  expect(obc.spec.bucketName).toBe('restate-snapshots')
  expect(obc.spec.storageClassName).toBe('rook-ceph-bucket')
  expect(bootstrap).toContain('argocd.argoproj.io/hook: PostSync')
  expect(bootstrap).toContain('snapshots create "$partition"')
  expect(bootstrap).toContain('backoffLimit: 0')
  expect(bootstrap).toContain('while [ "$SECONDS" -lt 840 ]')
  expect(bootstrap).toContain('$8 ~ /^[1-9][0-9]*$/')
  expect(bootstrap).toContain('if (!(i in seen) || !(i in archived)) exit 1')
  expect(bootstrap).toContain('Transient failure reading partition snapshot status; retrying')
  expect(bootstrap).toContain('docker.restate.dev/restatedev/restate:1.7.2')
  expect(rollback).toContain('argocd.argoproj.io/hook: PreSync')
  expect(rollback).toContain('config set --replication 1')
  expect(rollback).toContain('set-storage-state --nodes "$remove_ids" --storage-state read-only')
  expect(rollback).toContain('set-worker-state --nodes "$remove_ids" --worker-state draining')
  expect(rollback).toContain('metadata-server remove-node "$remove_ids"')
  expect(rollback).toContain('create_all_partition_snapshots --trim-log')
  expect(rollback).toContain('$8 ~ /^[1-9][0-9]*$/')
  expect(rollback).toContain('Refusing rollback before all safety snapshots are archived')
  expect(kustomization).toContain('- objectbucketclaim.yaml')
  expect(kustomization).not.toContain('- singleton-rollback-guard.yaml')
  expect(kustomization).toContain('- snapshot-bootstrap-job.yaml')
})

test('Restate snapshot bootstrap retries only partitions whose repository status is missing or invalid', () => {
  const bootstrap = YAML.parse(readRepoFile('argocd/applications/restate/snapshot-bootstrap-job.yaml')) as Record<
    string,
    any
  >
  const script = bootstrap.spec.template.spec.containers[0].command[2] as string
  const tempDir = mkdtempSync('/tmp/restate-snapshot-retry-')
  const restatectl = `${tempDir}/restatectl`
  const sleep = `${tempDir}/sleep`
  const calls = `${tempDir}/calls`

  try {
    writeFileSync(
      restatectl,
      `#!/bin/sh
set -eu
case " $* " in
  *" status "*) exit 0 ;;
  *" partitions list "*)
    i=0
    while [ "$i" -lt 24 ]; do
      archived=100
      if { [ "$i" -eq 0 ] && [ ! -f "${tempDir}/p0" ]; } || { [ "$i" -eq 1 ] && [ ! -f "${tempDir}/p1" ]; }; then archived=0; fi
      echo "$i N1:6 Leader Active e6 100 100 $archived 0 1 v62 - journal_v2 now"
      i=$((i + 1))
    done
    ;;
  *" snapshots create 0 "*) echo 0 >>"${calls}"; touch "${tempDir}/p0"; echo 'Snapshot created for partition 0: snap (log 0 @ LSN >= 100)' ;;
  *" snapshots create 1 "*) echo 1 >>"${calls}"; touch "${tempDir}/p1"; echo 'Snapshot created for partition 1: snap (log 1 @ LSN >= 100)' ;;
  *" snapshots create "*) echo "unexpected healthy partition snapshot request: $*" >&2; exit 91 ;;
  *) echo "unexpected restatectl invocation: $*" >&2; exit 90 ;;
esac
`,
    )
    writeFileSync(sleep, '#!/bin/sh\nexit 0\n')
    chmodSync(restatectl, 0o755)
    chmodSync(sleep, 0o755)

    const result = Bun.spawnSync(['/bin/bash', '-ceu', script], {
      env: { ...process.env, PATH: `${tempDir}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('All 24 partitions have an archived snapshot LSN')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(['0', '1'])
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
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

test('Restate resilience telemetry scrapes every node and audits exact operational state', () => {
  const alloy = readRepoFile('argocd/applications/observability/cluster-metrics-alloy-config.river')
  const rules = readRepoFile('argocd/applications/observability/graf-mimir-rules.yaml')
  const rulesConfig = YAML.parse(rules) as { data: Record<string, string> }
  const ruleGroups = YAML.parse(rulesConfig.data['graf-rules.yaml']) as {
    groups: Array<{ name: string; rules: Array<{ alert: string; expr: string; for?: string }> }>
  }
  const restateRules = ruleGroups.groups.find((group) => group.name === 'restate-control-plane.rules')?.rules ?? []
  const auditStale = restateRules.find((rule) => rule.alert === 'RestateControlPlaneAuditStale')
  const restoreNeverSucceeded = restateRules.find((rule) => rule.alert === 'RestateSnapshotRestoreDrillNeverSucceeded')
  const audit = readRepoFile('argocd/applications/restate/control-plane-audit-cronjob.yaml')
  const scripts = readRepoFile('argocd/applications/restate/resilience-scripts-configmap.yaml')

  for (const ordinal of [0, 1, 2]) {
    expect(alloy).toContain(`restate-${ordinal}.restate-cluster.restate.svc.cluster.local:5122`)
  }
  expect(rules).toContain('sum(up{job="restate-server", namespace="restate", service="restate"}) < 3')
  expect(rules).toContain('restate_partition_snapshot_age_seconds')
  expect(rules).toContain('restate_partition_store_snapshots_upload_failed_total')
  expect(rules).toContain('restate_partition_applied_lsn_lag')
  expect(rules).toContain('RestateControlPlaneAuditStale')
  expect(auditStale?.expr).toContain('absent(kube_cronjob_created')
  expect(auditStale?.expr).toContain('kube_cronjob_created')
  expect(auditStale?.expr).toContain('< time() - 600')
  expect(auditStale?.expr).toContain('> 600')
  expect(auditStale?.for).toBe('1m')
  expect(restoreNeverSucceeded?.expr).toContain('absent(kube_cronjob_created')
  expect(audit).toContain('docker.restate.dev/restatedev/restate:1.7.2')
  expect(scripts).toContain("status = 'paused'")
  expect(scripts).toContain("status = 'killed'")
  expect(scripts).toContain('i.pinned_deployment_id <> s.deployment_id')
  expect(scripts).toContain('expected_set[expected_ids[i]] = 1')
  expect(scripts).toContain('if (!(actual[i] in expected_set)) bad += 1')
})

test('Restate recovery proof opens all snapshots offline without exposing OBC credentials', () => {
  const proof = readRepoFile('argocd/applications/restate/snapshot-restore-proof-job.yaml')
  const drill = readRepoFile('argocd/applications/restate/snapshot-restore-drill-cronjob.yaml')
  const scripts = readRepoFile('argocd/applications/restate/resilience-scripts-configmap.yaml')
  const kustomization = readRepoFile('argocd/applications/restate/kustomization.yaml')
  const toolsDigest =
    'ghcr.io/restatedev/restate-tools@sha256:db618f42dbad37a79d8d4c543968f32d8d07aaa71cbcc8736f700f6c5f517209'

  expect(proof).toContain(toolsDigest)
  expect(drill).toContain(toolsDigest)
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
