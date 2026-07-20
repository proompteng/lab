import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const hermesImage =
  'registry.ide-newton.ts.net/lab/hermes-agent@sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a'
const squidImage = 'docker.io/ubuntu/squid@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c'

export const productionPaths = {
  kustomization: 'argocd/applications/hermes/kustomization.yaml',
  statefulSet: 'argocd/applications/hermes/statefulset.yaml',
  backupCronJob: 'argocd/applications/hermes/backup-cronjob.yaml',
  config: 'argocd/applications/hermes/config.yaml',
  externalSecret: 'argocd/applications/hermes/external-secret.yaml',
  networkPolicy: 'argocd/applications/hermes/network-policy.yaml',
  egressProxy: 'argocd/applications/hermes/egress-proxy.yaml',
  serviceAccount: 'argocd/applications/hermes/serviceaccount.yaml',
  migrationDryRun: 'argocd/applications/hermes/operations/migration-dry-run-job.yaml',
  migrationApply: 'argocd/applications/hermes/operations/migration-apply-job.yaml',
  restoreStage: 'argocd/applications/hermes/operations/restore-stage-pod.yaml',
  restore: 'argocd/applications/hermes/operations/restore-job.yaml',
  platform: 'argocd/applicationsets/platform.yaml',
  mimirRules: 'argocd/applications/observability/graf-mimir-rules.yaml',
  clusterMetrics: 'argocd/applications/observability/cluster-metrics-alloy-config.river',
  clusterMetricsDeployment: 'argocd/applications/observability/cluster-metrics-alloy-deployment.yaml',
  kubeStateMetrics: 'argocd/applications/observability/kube-state-metrics-values.yaml',
  runbook: 'docs/runbooks/hermes-production-rollout.md',
  impactMap: '.github/ci/impact-map.yml',
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

  for (const path of ['migrationDryRun', 'migrationApply', 'restore'] as const) {
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
  ])
  forbidTerms(failures, productionPaths.restoreStage, files.restoreStage, ['kind: Secret', ':latest'])
  requireTerms(failures, productionPaths.migrationDryRun, files.migrationDryRun, ['--preset', 'user-data', '--dry-run'])
  requireTerms(failures, productionPaths.migrationApply, files.migrationApply, ['--preset', 'user-data', '--yes'])

  const hermesApplication = files.platform.match(/\n\s+- name: hermes\n[\s\S]*?\n\s+- name: workers\n/)?.[0] ?? ''
  requireTerms(failures, productionPaths.platform, hermesApplication, [
    'path: argocd/applications/hermes',
    'namespace: hermes',
    'automation: manual',
    'external-secrets.proompteng.ai/enabled: "true"',
    'pod-security.kubernetes.io/enforce: restricted',
    'argocd.argoproj.io/sync-options: Prune=false',
  ])

  requireTerms(failures, productionPaths.runbook, files.runbook, [
    'Never run OpenClaw and Hermes with the same Discord token at the same time.',
    'Never pass `--migrate-secrets`',
    'Never run `hermes claw cleanup`',
    'A standalone Job does not update the CronJob',
    '## API key rotation',
    'Every API key rotation must restart `hermes-0`',
    'previous_secret_version=',
    'Authorization: Bearer $old_api_key',
    'Authorization: Bearer $new_api_key',
    'OpenClaw VM/PVC identities',
    'single-writer Discord message lifecycle IDs',
  ])
  const suspendBackupCommand =
    'kubectl -n hermes patch cronjob hermes-backup --type=merge -p \'{"spec":{"suspend":true}}\''
  if (count(files.runbook, suspendBackupCommand) !== 2) {
    failures.push(`${productionPaths.runbook}: migration and restore must both suspend the backup CronJob`)
  }
  const activeBackupSelector =
    'kubectl -n hermes get jobs -l app.kubernetes.io/name=hermes,app.kubernetes.io/component=backup'
  if (count(files.runbook, activeBackupSelector) !== 2) {
    failures.push(`${productionPaths.runbook}: migration and restore must both wait for active backup Jobs`)
  }

  requireTerms(failures, productionPaths.mimirRules, files.mimirRules, [
    'alert: HermesGatewayUnavailable',
    'alert: HermesEgressProxyUnavailable',
    'alert: HermesBackupStale',
    'absent(\n                kube_statefulset_status_replicas_ready{',
    'absent(\n                kube_deployment_status_replicas_available{',
    'time() - kube_cronjob_status_last_successful_time{',
    'time() - kube_cronjob_created{',
    'unless on (namespace, cronjob)',
    'absent(\n                kube_cronjob_created{',
  ])

  requireTerms(failures, productionPaths.clusterMetrics, files.clusterMetrics, [
    'kube_cronjob_created',
    'kube_cronjob_status_last_successful_time',
    'kube_statefulset_status_replicas_ready',
  ])
  const clusterMetricsHash = createHash('sha256').update(files.clusterMetrics).digest('hex')
  requireTerms(failures, productionPaths.clusterMetricsDeployment, files.clusterMetricsDeployment, [
    `observability.proompteng.ai/config-sha256: ${clusterMetricsHash}`,
  ])
  requireTerms(failures, productionPaths.kubeStateMetrics, files.kubeStateMetrics, ['  - cronjobs', '  - statefulsets'])

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
