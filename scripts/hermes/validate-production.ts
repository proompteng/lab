import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const hermesImage =
  'registry.ide-newton.ts.net/lab/hermes-agent@sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a'
const squidImage = 'docker.io/ubuntu/squid@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c'

export const productionPaths = {
  kustomization: 'argocd/applications/hermes/kustomization.yaml',
  statefulSet: 'argocd/applications/hermes/statefulset.yaml',
  backupCronJob: 'argocd/applications/hermes/backup-cronjob.yaml',
  backupScript: 'argocd/applications/hermes/backup-once.sh',
  config: 'argocd/applications/hermes/config.yaml',
  externalSecret: 'argocd/applications/hermes/external-secret.yaml',
  networkPolicy: 'argocd/applications/hermes/network-policy.yaml',
  egressProxy: 'argocd/applications/hermes/egress-proxy.yaml',
  serviceAccount: 'argocd/applications/hermes/serviceaccount.yaml',
  migrationDryRun: 'argocd/applications/hermes/operations/migration-dry-run-job.yaml',
  migrationApply: 'argocd/applications/hermes/operations/migration-apply-job.yaml',
  restoreStage: 'argocd/applications/hermes/operations/restore-stage-pod.yaml',
  restore: 'argocd/applications/hermes/operations/restore-job.yaml',
  migrationAudit: 'scripts/hermes/audit-migration-source.ts',
  networkPolicyProbe: 'scripts/hermes/verify-network-policy-enforcement.sh',
  maintenanceWait: 'scripts/hermes/wait-for-maintenance.sh',
  maintenanceLock: 'scripts/hermes/maintenance-lock.sh',
  platform: 'argocd/applicationsets/platform.yaml',
  mimirRules: 'argocd/applications/observability/graf-mimir-rules.yaml',
  clusterMetrics: 'argocd/applications/observability/cluster-metrics-alloy-config.river',
  clusterMetricsDeployment: 'argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
  kubeStateMetrics: 'argocd/applications/observability/kube-state-metrics-values.yaml',
  runbook: 'docs/runbooks/hermes-production-rollout.md',
  impactMap: '.github/ci/impact-map.yml',
  pullRequestWorkflow: '.github/workflows/pull-request.yml',
} as const

export type ProductionPath = keyof typeof productionPaths
export type ProductionFiles = Record<ProductionPath, string>

function count(content: string, term: string): number {
  return content.split(term).length - 1
}

function requireTerms(failures: string[], path: string, content: string, terms: string[]): void {
  for (const term of terms) {
    if (!content.includes(term)) {
      failures.push(`${path}: missing production invariant ${JSON.stringify(term)}`)
    }
  }
}

function forbidTerms(failures: string[], path: string, content: string, terms: string[]): void {
  for (const term of terms) {
    if (content.includes(term)) {
      failures.push(`${path}: contains forbidden production term ${JSON.stringify(term)}`)
    }
  }
}

export async function loadProductionFiles(): Promise<ProductionFiles> {
  const entries = await Promise.all(
    Object.entries(productionPaths).map(async ([name, path]) => [name, await readFile(path, 'utf8')] as const),
  )
  return Object.fromEntries(entries) as ProductionFiles
}

export function validateProductionContent(files: ProductionFiles): string[] {
  const failures: string[] = []

  requireTerms(failures, productionPaths.kustomization, files.kustomization, [
    'namespace: hermes',
    '- statefulset.yaml',
    '- backup-cronjob.yaml',
    '- network-policy.yaml',
    '- external-secret.yaml',
  ])
  forbidTerms(failures, productionPaths.kustomization, files.kustomization, [
    'kind: Namespace',
    'maintenance-lease.yaml',
    'operations/',
    'migration-apply-job.yaml',
    'restore-job.yaml',
  ])
  if (count(files.statefulSet, `image: ${hermesImage}`) !== 2) {
    failures.push(
      `${productionPaths.statefulSet}: the bootstrap and gateway containers must use the mirrored immutable amd64 digest`,
    )
  }
  requireTerms(failures, productionPaths.statefulSet, files.statefulSet, [
    'persistentVolumeClaimRetentionPolicy:',
    'whenDeleted: Retain',
    'whenScaled: Retain',
    'automountServiceAccountToken: false',
    'runAsUser: 10000',
    'runAsGroup: 10000',
    'readOnlyRootFilesystem: true',
    'capabilities:\n              drop:\n                - ALL',
    'seccompProfile:\n              type: RuntimeDefault',
    'API_SERVER_KEY',
    'name: data',
    'name: backups',
    'mountPath: /opt/backups\n              readOnly: true',
    'storageClassName: rook-ceph-block',
  ])
  forbidTerms(failures, productionPaths.statefulSet, files.statefulSet, [
    ':latest',
    'privileged: true',
    'hostPath:',
    'hostNetwork: true',
    'hostPID: true',
    '        - name: backup\n',
  ])

  if (count(files.backupCronJob, `image: ${hermesImage}`) !== 1) {
    failures.push(`${productionPaths.backupCronJob}: backup must use the immutable mirrored Hermes digest`)
  }
  requireTerms(failures, productionPaths.backupCronJob, files.backupCronJob, [
    'kind: CronJob',
    'suspend: false',
    'concurrencyPolicy: Forbid',
    'backoffLimit: 3',
    'restartPolicy: OnFailure',
    'requiredDuringSchedulingIgnoredDuringExecution:',
    'jobTemplate:\n    metadata:\n      labels:\n        app.kubernetes.io/name: hermes\n        app.kubernetes.io/component: backup',
    'app.kubernetes.io/component: gateway',
    'kubernetes.io/arch: amd64',
    'automountServiceAccountToken: false',
    'runAsUser: 10000',
    'readOnlyRootFilesystem: true',
    '/opt/bootstrap/backup-once.sh',
    'claimName: data-hermes-0',
    'claimName: backups-hermes-0',
  ])
  forbidTerms(failures, productionPaths.backupCronJob, files.backupCronJob, [':latest', 'restartPolicy: Never'])

  const backupPublicationSteps = [
    'pending_digest=$(sha256sum "$pending_archive")',
    'printf \'%s  %s\\n\' "$expected_digest" "$pending_archive" | sha256sum -c -',
    'mv -- "$pending_checksum" "$archive.sha256"',
    'mv -- "$pending_archive" "$archive"',
    '(cd "$backup_dir" && sha256sum -c "$archive_name.sha256")',
  ]
  requireTerms(failures, productionPaths.backupScript, files.backupScript, backupPublicationSteps)
  const backupPublicationPositions = backupPublicationSteps.map((step) => files.backupScript.indexOf(step))
  if (
    backupPublicationPositions.some((position) => position < 0) ||
    backupPublicationPositions.some(
      (position, index) => index > 0 && position <= backupPublicationPositions[index - 1]!,
    )
  ) {
    failures.push(
      `${productionPaths.backupScript}: backup must verify the hidden archive before publishing its checksum and archive`,
    )
  }

  requireTerms(failures, productionPaths.config, files.config, [
    '_config_version: 33',
    'base_url: http://flamingo.flamingo.svc.cluster.local/v1',
    'discord:\n    enabled: false',
    'api_server:\n    enabled: true',
    'cron_mode: deny',
    'orchestrator_enabled: false',
    'inherit_mcp_toolsets: false',
    'mcp_servers: {}',
    'hooks_auto_accept: false',
  ])
  forbidTerms(failures, productionPaths.config, files.config, ['api_key:', 'token:', 'allow_all_users: true'])

  requireTerms(failures, productionPaths.externalSecret, files.externalSecret, [
    'name: onepassword-infra',
    'deletionPolicy: Retain',
    'key: hermes-runtime/API_SERVER_KEY',
  ])
  forbidTerms(failures, productionPaths.externalSecret, files.externalSecret, ['dataFrom:', 'kind: Secret'])

  requireTerms(failures, productionPaths.networkPolicy, files.networkPolicy, [
    'name: hermes-default-deny',
    'podSelector: {}',
    'namespace: hermes',
    'cidr: 0.0.0.0/0',
    '- 10.0.0.0/8',
    '- 100.64.0.0/10',
    '- 169.254.0.0/16',
    '- 192.168.0.0/16',
  ])
  forbidTerms(failures, productionPaths.networkPolicy, files.networkPolicy, [
    '          port: 80\n',
    '          port: 22\n',
  ])

  if (count(files.egressProxy, `image: ${squidImage}`) !== 1) {
    failures.push(`${productionPaths.egressProxy}: Squid must use its immutable reviewed digest`)
  }
  requireTerms(failures, productionPaths.egressProxy, files.egressProxy, [
    'automountServiceAccountToken: false',
    'runAsUser: 13',
    'readOnlyRootFilesystem: true',
    'allowPrivilegeEscalation: false',
  ])

  requireTerms(failures, productionPaths.serviceAccount, files.serviceAccount, [
    'kind: ServiceAccount',
    'automountServiceAccountToken: false',
  ])
  forbidTerms(failures, productionPaths.serviceAccount, files.serviceAccount, [
    'kind: Role',
    'kind: ClusterRole',
    'kind: RoleBinding',
    'kind: ClusterRoleBinding',
  ])

  const operationDeadlines = {
    migrationDryRun: 600,
    migrationApply: 600,
    restore: 900,
  } as const
  for (const path of Object.keys(operationDeadlines) as (keyof typeof operationDeadlines)[]) {
    const content = files[path]
    if (count(content, `image: ${hermesImage}`) !== 1) {
      failures.push(`${productionPaths[path]}: operation must use the immutable mirrored Hermes digest`)
    }
    requireTerms(failures, productionPaths[path], content, [
      'automountServiceAccountToken: false',
      'kubernetes.io/arch: amd64',
      'runAsUser: 10000',
      'readOnlyRootFilesystem: true',
      'backoffLimit: 0',
      `activeDeadlineSeconds: ${operationDeadlines[path]}`,
    ])
    forbidTerms(failures, productionPaths[path], content, ['--migrate-secrets', 'kind: Secret', ':latest'])
  }
  if (count(files.restoreStage, `image: ${hermesImage}`) !== 1) {
    failures.push(`${productionPaths.restoreStage}: restore staging must use the immutable mirrored Hermes digest`)
  }
  requireTerms(failures, productionPaths.restoreStage, files.restoreStage, [
    'automountServiceAccountToken: false',
    'kubernetes.io/arch: amd64',
    'runAsUser: 10000',
    'readOnlyRootFilesystem: true',
    'claimName: backups-hermes-0',
    'activeDeadlineSeconds: 3900',
  ])
  forbidTerms(failures, productionPaths.restoreStage, files.restoreStage, ['kind: Secret', ':latest'])
  requireTerms(failures, productionPaths.migrationDryRun, files.migrationDryRun, ['--preset', 'user-data', '--dry-run'])
  requireTerms(failures, productionPaths.migrationApply, files.migrationApply, ['--preset', 'user-data', '--yes'])
  requireTerms(failures, productionPaths.migrationAudit, files.migrationAudit, [
    "allowedWorkspaceDirectories = new Set(['memory', 'skills'])",
    'source root must be a real directory',
    'source contains no approved files',
    'requiredMigrationPaths',
    'required migration path is missing',
    'symbolic links are forbidden',
    'only regular files and directories are allowed',
    "new TextDecoder('utf-8', { fatal: true })",
    'binary content is forbidden',
    'credentialPatterns',
    'opaqueTokenPattern',
    'shannonEntropy(candidate) >= 3.5',
    "reason: 'opaque high-entropy value'",
    'isCredentialLikePathComponent',
    "'[redacted-credential-component]'",
    "return 'credential-like path component is forbidden'",
    'migration source audit failed',
    '${issue.path}: ${issue.reason}',
  ])
  requireTerms(failures, productionPaths.networkPolicyProbe, files.networkPolicyProbe, [
    'set -euo pipefail',
    `readonly hermes_image='${hermesImage}'`,
    'probe_namespace="hermes-network-policy-probe-$(openssl rand -hex 4)"',
    'readonly probe_namespace',
    'probe_namespace_created=false',
    'cleanup_probe() {',
    'if [[ "$probe_namespace_created" == true ]]',
    'trap cleanup_probe EXIT',
    'trap abort_probe HUP INT TERM',
    'kubectl -n default create namespace "$probe_namespace"',
    'kubectl -n default delete namespace "$probe_namespace" --ignore-not-found --wait=true --timeout=5m',
    'pod-security.kubernetes.io/enforce=restricted',
    'kind: NetworkPolicy',
    'name: deny-client-egress',
    'egress: []',
    'baseline_reachable=false',
    'policy_enforced=false',
    'except urllib.error.HTTPError:',
    'except (TimeoutError, OSError, urllib.error.URLError):',
    'raise SystemExit(42)',
    'raise SystemExit(43)',
    'verify_probe_health() {',
    'urllib.request.urlopen("http://127.0.0.1:8080/", timeout=2).read(1)',
    'if [[ "$request_status" -eq 42 ]]',
    'delete networkpolicy deny-client-egress --wait=true --timeout=1m',
    'policy_released=false',
    'if [[ "$policy_released" != true ]]',
    "echo 'NetworkPolicy removal did not restore baseline connectivity; do not sync Hermes' >&2",
    "echo 'NetworkPolicy is not enforced; do not sync Hermes' >&2",
    "printf 'network_policy_enforced=true\\n'",
  ])
  for (const term of [
    'activeDeadlineSeconds: 600',
    'automountServiceAccountToken: false',
    'kubernetes.io/arch: amd64',
    'readOnlyRootFilesystem: true',
    'requiredDuringSchedulingIgnoredDuringExecution:',
  ]) {
    if (count(files.networkPolicyProbe, term) !== 2) {
      failures.push(`${productionPaths.networkPolicyProbe}: both probe Pods must enforce ${JSON.stringify(term)}`)
    }
  }
  forbidTerms(failures, productionPaths.networkPolicyProbe, files.networkPolicyProbe, [
    ':latest',
    'privileged: true',
    'hostNetwork: true',
    'serviceAccountName:',
    'if ! probe_request',
  ])
  const probeBaselineIndex = files.networkPolicyProbe.indexOf('if [[ "$baseline_reachable" != true ]]')
  const probePolicyIndex = files.networkPolicyProbe.indexOf('name: deny-client-egress')
  const probeEnforcementIndex = files.networkPolicyProbe.indexOf('if [[ "$policy_enforced" != true ]]')
  const probeReleaseIndex = files.networkPolicyProbe.indexOf('if [[ "$policy_released" != true ]]')
  if (
    probeBaselineIndex < 0 ||
    probePolicyIndex <= probeBaselineIndex ||
    probeEnforcementIndex <= probePolicyIndex ||
    probeReleaseIndex <= probeEnforcementIndex
  ) {
    failures.push(
      `${productionPaths.networkPolicyProbe}: baseline connectivity must pass before the deny policy is tested`,
    )
  }
  const probeHttpErrorIndex = files.networkPolicyProbe.indexOf('except urllib.error.HTTPError:')
  const probeNetworkErrorIndex = files.networkPolicyProbe.indexOf(
    'except (TimeoutError, OSError, urllib.error.URLError):',
  )
  if (probeHttpErrorIndex < 0 || probeNetworkErrorIndex <= probeHttpErrorIndex) {
    failures.push(`${productionPaths.networkPolicyProbe}: HTTP responses must not count as policy denials`)
  }
  requireTerms(failures, productionPaths.maintenanceWait, files.maintenanceWait, [
    'set -euo pipefail',
    'readonly namespace=hermes',
    'app.kubernetes.io/component in (migration,restore)',
    'readonly restore_stage_pod=hermes-restore-stage',
    '--cleanup-restore-stage',
    'HERMES_MAINTENANCE_WAIT_TIMEOUT_SECONDS',
    'kubectl -n "$namespace" get jobs -l "$selector" -o json',
    '.type == "Complete" or .type == "Failed"',
    'active Hermes migration or restore Job did not terminate',
    'Hermes restore staging Pod exists; retry restore with --cleanup-restore-stage',
    'delete pod "$restore_stage_pod" --wait=true --timeout=10m',
  ])
  requireTerms(failures, productionPaths.maintenanceLock, files.maintenanceLock, [
    'set -euo pipefail',
    'readonly lease=hermes-maintenance',
    '^(acquire|release|recover)$',
    'ensure_lease() {',
    'kubectl -n "$namespace" create -f -',
    'app.kubernetes.io/component: maintenance',
    'holderIdentity: ""',
    'leaseDurationSeconds: 14400',
    '    ensure_lease',
    'date -u +%Y-%m-%dT%H:%M:%S.000000Z',
    '{op: "test", path: "/spec/holderIdentity", value: $expected}',
    '{op: "replace", path: "/spec/holderIdentity", value: $replacement}',
    'patch lease "$lease" --type=json',
    'refusing to release a Hermes maintenance Lease held by another operator',
    'wait-for-maintenance.sh',
  ])

  const hermesApplication = files.platform.match(/\n\s+- name: hermes\n[\s\S]*?\n\s+- name: workers\n/)?.[0] ?? ''
  requireTerms(failures, productionPaths.platform, hermesApplication, [
    'path: argocd/applications/hermes',
    'namespace: hermes',
    'automation: manual',
    'group: apps',
    'kind: StatefulSet',
    'name: hermes',
    '- .spec.volumeClaimTemplates[].apiVersion',
    '- .spec.volumeClaimTemplates[].kind',
    '- .spec.volumeClaimTemplates[].spec.volumeMode',
    '- .spec.volumeClaimTemplates[].status',
    'external-secrets.proompteng.ai/enabled: "true"',
    'observability.proompteng.ai/hermes-rollout-enabled: "true"',
    'pod-security.kubernetes.io/enforce: restricted',
    'argocd.argoproj.io/sync-options: Prune=false',
  ])
  forbidTerms(failures, productionPaths.platform, hermesApplication, [
    'group: coordination.k8s.io',
    'kind: Lease',
    'name: hermes-maintenance',
    '- .spec.volumeClaimTemplates\n',
  ])

  requireTerms(failures, productionPaths.runbook, files.runbook, [
    'Never run OpenClaw and Hermes with the same Discord token at the same time.',
    'Never pass `--migrate-secrets`',
    'Never run `hermes claw cleanup`',
    'Never create a migration or restore Job until every earlier Hermes maintenance Job is terminal.',
    'Never enable Hermes Discord until a final audited migration is applied after the OpenClaw gateway is inactive.',
    'Never sync Hermes until the disposable NetworkPolicy enforcement probe passes on the live cluster.',
    'kubectl -n hermes get namespace hermes -o json',
    'Argo CD globally excludes Kubernetes Lease objects',
    "stale_maintenance_holder=$(kubectl -n hermes get lease hermes-maintenance -o jsonpath='{.spec.holderIdentity}')",
    'maintenance-lock.sh recover "$stale_maintenance_holder"',
    'A standalone Job does not update the CronJob',
    '## API key rotation',
    'Every API key rotation must restart `hermes-0`',
    'previous_secret_version=',
    'Authorization: Bearer $old_api_key',
    'Authorization: Bearer $new_api_key',
    'OpenClaw VM/PVC identities',
    'single-writer Discord message lifecycle IDs',
    'bun run scripts/hermes/audit-migration-source.ts "$hermes_stage_dir/openclaw"',
    'An audit failure blocks migration:',
    'redact or remove only the',
    'flagged material in `$hermes_stage_dir`',
    'Never weaken or bypass the patterns.',
    '.metadata.labels["observability.proompteng.ai/hermes-rollout-enabled"] == "true"',
    'kubectl -n hermes delete "$dry_run_job" --wait=true',
    'kubectl -n hermes delete "$migration_job" --wait=true',
    'kubectl -n hermes delete "$restore_job" --wait=true',
    'for path in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md memory; do test -r "$path"; done',
    'The CronJob must remain suspended until every prior backup',
    'if kubectl -n hermes exec hermes-0 -c hermes -- /opt/hermes/.venv/bin/python -c',
    'direct public egress unexpectedly succeeded',
    "'rm -rf -- /opt/data/migration/openclaw && mkdir -p /opt/data/migration/openclaw'",
    "find /opt/backups -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print",
    'test "$sidecar_archive" = "$archive_name"',
    'test "$sidecar_archive" = "$archive"',
    'printf "%s  %s\\n" "$expected_digest" "$archive_path" | sha256sum -c -',
    'printf "%s  %s\\n" "$expected_digest" "$archive" | sha256sum -c -',
  ])
  const releaseEvidenceSection = files.runbook.match(/## Release evidence[\s\S]*?## Phase 0:/)?.[0] ?? ''
  requireTerms(failures, productionPaths.runbook, releaseEvidenceSection, [
    'set -euo pipefail',
    'git fetch --quiet origin main',
    'main_revision=$(git rev-parse origin/main)',
    'test "$(git rev-parse HEAD)" = "$main_revision"',
    'test "$upstream_digest" = sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973',
    'test "$mirror_digest" = sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a',
    'argocd app get hermes --refresh >/dev/null',
    "hermes_revision=$(kubectl -n argocd get application hermes -o jsonpath='{.status.sync.revision}')",
    'test "$hermes_revision" = "$main_revision"',
  ])
  const phaseZeroSection = files.runbook.match(/## Phase 0:[\s\S]*?## Phase 1:/)?.[0] ?? ''
  requireTerms(failures, productionPaths.runbook, phaseZeroSection, [
    'bash scripts/hermes/verify-network-policy-enforcement.sh',
    '`NetworkPolicy is not enforced` is a hard rollout blocker.',
    'test "$api_key_bytes" -ge 32',
    'printf \'%s\\n\' "$api_key_bytes"',
    "hermes_deployed_revision=$(kubectl -n argocd get application hermes -o json | jq -r '.status.history[-1].revision // empty')",
    'test "$hermes_deployed_revision" = "$(git rev-parse HEAD)"',
  ])
  const networkPolicyProbeIndex = phaseZeroSection.indexOf('bash scripts/hermes/verify-network-policy-enforcement.sh')
  const initialHermesSyncIndex = phaseZeroSection.indexOf('argocd app sync hermes --prune=false')
  if (networkPolicyProbeIndex < 0 || initialHermesSyncIndex <= networkPolicyProbeIndex) {
    failures.push(`${productionPaths.runbook}: NetworkPolicy enforcement must be proven before the first Hermes sync`)
  }
  if (count(phaseZeroSection, 'set -euo pipefail') !== 2) {
    failures.push(`${productionPaths.runbook}: secret creation and bridge verification must both fail closed`)
  }
  const rotationSection = files.runbook.match(/## API key rotation[\s\S]*?## Maintenance lock recovery/)?.[0] ?? ''
  requireTerms(failures, productionPaths.runbook, rotationSection, [
    'set -euo pipefail',
    'trap cleanup_rotation EXIT',
    'kubectl -n hermes delete pod hermes-0',
    'kubectl -n hermes rollout status statefulset/hermes --timeout=15m',
    'rotation_port_forward_log=$(mktemp)',
    'kubectl -n hermes port-forward service/hermes 18642:8642',
    'test "$rotation_listener_ready" = true',
    'test "$(curl -sS -o /dev/null -w \'%{http_code}\' -H "Authorization: Bearer $old_api_key"',
    'curl -fsS -H "Authorization: Bearer $new_api_key"',
    'cleanup_rotation',
  ])
  forbidTerms(failures, productionPaths.runbook, files.runbook, [
    '--ignore-failed-read',
    'kubectl -n hermes exec hermes-0 -c hermes -- mkdir -p /opt/data/migration/openclaw',
    'kubectl -n hermes exec hermes-restore-stage -c stage -- ls -1 /opt/backups/hermes-backup-*.zip',
  ])
  const suspendBackupCommand =
    'kubectl -n hermes patch cronjob hermes-backup --type=merge -p \'{"spec":{"suspend":true}}\''
  if (count(files.runbook, suspendBackupCommand) !== 3) {
    failures.push(`${productionPaths.runbook}: canary, migration, and restore must suspend the backup CronJob`)
  }
  const activeBackupSelector =
    'kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup'
  if (count(files.runbook, `while [ "$(${activeBackupSelector}`) !== 3) {
    failures.push(`${productionPaths.runbook}: canary, migration, and restore must wait for active backup Jobs`)
  }
  const migrationSection = files.runbook.match(/## Phase 2:[\s\S]*?## Phase 3:/)?.[0] ?? ''
  if (
    migrationSection.indexOf(suspendBackupCommand) > migrationSection.indexOf('rm -rf -- /opt/data/migration/openclaw')
  ) {
    failures.push(`${productionPaths.runbook}: migration must quiesce backups before replacing the staging tree`)
  }
  const maintenanceWaitCommand = 'bash scripts/hermes/wait-for-maintenance.sh'
  const maintenanceAcquireCommand = 'bash scripts/hermes/maintenance-lock.sh acquire "$maintenance_holder"'
  const maintenanceOwnershipAssertion =
    'test "$(kubectl -n hermes get lease hermes-maintenance -o jsonpath=\'{.spec.holderIdentity}\')" = "$maintenance_holder"'
  const restoreStageCleanupCommand = `${maintenanceWaitCommand} --cleanup-restore-stage`
  const phaseOneSection = files.runbook.match(/## Phase 1:[\s\S]*?## API key rotation/)?.[0] ?? ''
  const restoreSection = files.runbook.match(/### Restore Hermes data[\s\S]*?## Completion evidence/)?.[0] ?? ''
  if (count(migrationSection, maintenanceWaitCommand) !== 3 || count(restoreSection, maintenanceWaitCommand) !== 3) {
    failures.push(`${productionPaths.runbook}: every migration and restore operation must wait for maintenance Jobs`)
  }
  if (
    count(phaseOneSection, maintenanceAcquireCommand) !== 1 ||
    count(migrationSection, maintenanceAcquireCommand) !== 1 ||
    count(restoreSection, maintenanceAcquireCommand) !== 1
  ) {
    failures.push(`${productionPaths.runbook}: every maintenance operation must acquire the atomic Lease`)
  }
  if (
    count(phaseOneSection, 'trap release_maintenance_lock EXIT') !== 1 ||
    count(migrationSection, 'trap release_maintenance_lock EXIT') !== 1 ||
    count(restoreSection, 'trap release_maintenance_lock EXIT') !== 1 ||
    count(phaseOneSection, 'abort_maintenance()') !== 1 ||
    count(migrationSection, 'abort_maintenance()') !== 1 ||
    count(restoreSection, 'abort_maintenance()') !== 1
  ) {
    failures.push(`${productionPaths.runbook}: every maintenance Lease must release on exit and signals`)
  }
  const initialBackupCreateIndex = phaseOneSection.indexOf(
    'kubectl -n hermes create job --from=cronjob/hermes-backup "$initial_backup_job"',
  )
  const initialBackupAcquireIndex = phaseOneSection.indexOf(maintenanceAcquireCommand)
  const initialBackupWaitIndex = phaseOneSection.indexOf(maintenanceWaitCommand)
  const initialBackupReleaseIndex = phaseOneSection.lastIndexOf('\n   release_maintenance_lock\n')
  if (
    count(phaseOneSection, '\n   release_maintenance_lock\n') !== 1 ||
    initialBackupAcquireIndex < 0 ||
    initialBackupWaitIndex <= initialBackupAcquireIndex ||
    initialBackupCreateIndex <= initialBackupWaitIndex ||
    initialBackupReleaseIndex <= initialBackupCreateIndex
  ) {
    failures.push(`${productionPaths.runbook}: the one-off canary backup must hold the maintenance Lease`)
  }
  const migrationAcquireIndex = migrationSection.indexOf(maintenanceAcquireCommand)
  const migrationDryRunIndex = migrationSection.indexOf('migration-dry-run-job.yaml')
  const migrationApplyIndex = migrationSection.indexOf('migration-apply-job.yaml')
  const migrationSyncIndex = migrationSection.indexOf('argocd app sync hermes --prune=false')
  const migrationReleaseIndex = migrationSection.lastIndexOf('\n   release_maintenance_lock\n')
  if (
    count(migrationSection, maintenanceOwnershipAssertion) !== 3 ||
    count(migrationSection, '\n   release_maintenance_lock\n') !== 1 ||
    migrationAcquireIndex < 0 ||
    migrationDryRunIndex <= migrationAcquireIndex ||
    migrationApplyIndex <= migrationDryRunIndex ||
    migrationSyncIndex <= migrationApplyIndex ||
    migrationReleaseIndex <= migrationSyncIndex
  ) {
    failures.push(`${productionPaths.runbook}: migration must hold one Lease from staging through apply`)
  }
  for (const [section, createCommand] of [
    [migrationSection, 'migration-dry-run-job.yaml'],
    [migrationSection, 'migration-apply-job.yaml'],
    [restoreSection, 'restore-job.yaml'],
  ] as const) {
    const createIndex = section.indexOf(createCommand)
    if (createIndex < 0 || section.lastIndexOf(maintenanceWaitCommand, createIndex) < 0) {
      failures.push(`${productionPaths.runbook}: ${createCommand} must be preceded by the maintenance Job wait`)
    }
  }
  const restoreStageCreateIndex = restoreSection.indexOf('restore-stage-pod.yaml')
  if (
    restoreStageCreateIndex < 0 ||
    restoreSection.lastIndexOf(restoreStageCleanupCommand, restoreStageCreateIndex) < 0 ||
    !restoreSection.includes(
      `${restoreStageCleanupCommand}\nkubectl -n hermes create -f argocd/applications/hermes/operations/restore-stage-pod.yaml`,
    )
  ) {
    failures.push(`${productionPaths.runbook}: restore staging must clean up a stale staging Pod before create`)
  }
  const idempotentHermesStop = 'hermes_pod_name=$(kubectl -n hermes get pod hermes-0 --ignore-not-found -o name)'
  if (
    count(migrationSection, idempotentHermesStop) !== 1 ||
    count(restoreSection, idempotentHermesStop) !== 1 ||
    files.runbook.includes('kubectl -n hermes wait pod/hermes-0 --for=delete')
  ) {
    failures.push(
      `${productionPaths.runbook}: migration and restore must treat an already-absent Hermes gateway as stopped`,
    )
  }
  const cutoverSection = files.runbook.match(/## Phase 3:[\s\S]*?## Rollback/)?.[0] ?? ''
  requireTerms(failures, productionPaths.runbook, cutoverSection, [
    'systemctl --user stop openclaw-gateway.service',
    'repeat Phase 2 steps 1 through 4 from a fresh `hermes_stage_dir`',
    'Do not reuse the earlier archive.',
    'do not run Phase 2 step 5 because merged `main` now enables',
    'Keep the same Phase 2 shell and Lease open through cutover step 5.',
    'argocd app sync openclaw --prune=false',
    'openclaw_vmi_name=$(kubectl -n openclaw get virtualmachineinstance openclaw --ignore-not-found -o name)',
    'Sync Hermes from merged `main` only after the OpenClaw VMI is gone',
  ])
  if (cutoverSection.includes('kubectl -n openclaw wait virtualmachineinstance/openclaw --for=delete')) {
    failures.push(`${productionPaths.runbook}: cutover must treat an already-absent OpenClaw VMI as stopped`)
  }
  const cutoverOpenClawSyncIndex = cutoverSection.indexOf('argocd app sync openclaw --prune=false')
  const cutoverHermesSyncIndex = cutoverSection.indexOf('argocd app sync hermes --prune=false')
  const cutoverReleaseIndex = cutoverSection.lastIndexOf('\n   release_maintenance_lock\n')
  if (
    count(cutoverSection, maintenanceOwnershipAssertion) !== 2 ||
    count(cutoverSection, '\n   release_maintenance_lock\n') !== 1 ||
    cutoverOpenClawSyncIndex < 0 ||
    cutoverHermesSyncIndex <= cutoverOpenClawSyncIndex ||
    cutoverReleaseIndex <= cutoverHermesSyncIndex
  ) {
    failures.push(`${productionPaths.runbook}: cutover must hold the migration Lease until Hermes is restored`)
  }
  if (
    cutoverSection.indexOf('systemctl --user stop openclaw-gateway.service') >
    cutoverSection.indexOf('repeat Phase 2 steps 1 through 4')
  ) {
    failures.push(`${productionPaths.runbook}: final reconciliation must happen after the OpenClaw gateway is stopped`)
  }

  const hermesRuleGroup =
    files.mimirRules.match(/      - name: hermes-production\.rules[\s\S]*?(?=\n      - name:)/)?.[0] ?? ''
  requireTerms(failures, productionPaths.mimirRules, hermesRuleGroup, [
    'alert: HermesGatewayUnavailable',
    'alert: HermesEgressProxyUnavailable',
    'alert: HermesBackupStale',
    'record: hermes_rollout_enabled',
    'kube_argocd_application_deployment_history_info{',
    'namespace="argocd"',
    'application="hermes"',
    'absent(\n                  kube_statefulset_status_replicas_ready{',
    'absent(\n                  kube_deployment_status_replicas_available{',
    'time() - kube_cronjob_status_last_successful_time{',
    'time() - kube_cronjob_created{',
    'unless on (namespace, cronjob)',
    'absent(\n                  kube_cronjob_created{',
  ])
  if (count(hermesRuleGroup, '(hermes_rollout_enabled == 1)') !== 3) {
    failures.push(`${productionPaths.mimirRules}: all absent-series alerts must be gated on rollout enablement`)
  }
  forbidTerms(failures, productionPaths.mimirRules, hermesRuleGroup, [
    '[30d]',
    'or\n                hermes_rollout_enabled',
    'kube_namespace_labels',
  ])

  requireTerms(failures, productionPaths.clusterMetrics, files.clusterMetrics, [
    'kube_argocd_application_deployment_history_info',
    'kube_cronjob_created',
    'kube_cronjob_status_last_successful_time',
    'kube_statefulset_status_replicas_ready',
  ])
  const clusterMetricsHash = createHash('sha256').update(files.clusterMetrics).digest('hex')
  requireTerms(failures, productionPaths.clusterMetricsDeployment, files.clusterMetricsDeployment, [
    `observability.proompteng.ai/config-sha256: ${clusterMetricsHash}`,
  ])
  requireTerms(failures, productionPaths.kubeStateMetrics, files.kubeStateMetrics, [
    '  - cronjobs',
    '  - namespaces',
    '  - statefulsets',
    'customResourceState:\n  enabled: true',
    'group: argoproj.io',
    'kind: Application',
    'metricNamePrefix: kube_argocd',
    'name: application_deployment_history_info',
    '                    - history\n                    - "0"',
    '        - applications',
    '        - list\n        - watch',
  ])

  requireTerms(failures, productionPaths.impactMap, files.impactMap, [
    '- .github/ci/impact-map.yml',
    '- .github/workflows/pull-request.yml',
    '- argocd/applications/hermes/**',
    '- argocd/applications/observability/cluster-metrics-alloy-config.river',
    '- argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
    '- argocd/applications/observability/graf-mimir-rules.yaml',
    '- argocd/applications/observability/kube-state-metrics-values.yaml',
    '- argocd/applicationsets/platform.yaml',
    '- docs/runbooks/hermes-production-rollout.md',
    '- scripts/**',
  ])
  requireTerms(failures, productionPaths.pullRequestWorkflow, files.pullRequestWorkflow, [
    'bun run scripts/hermes/validate-production.ts',
    'bun test scripts/hermes/*.test.ts',
  ])

  return failures
}

async function main(): Promise<void> {
  const failures = validateProductionContent(await loadProductionFiles())
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log(`validated ${Object.keys(productionPaths).length} Hermes production surfaces`)
}

if (import.meta.main) {
  await main()
}
