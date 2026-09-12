import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'bun:test'

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/torghut-post-deploy-verify.yml', import.meta.url),
  'utf8',
)
const agentsCiClusterRbac = readFileSync(
  new URL('../../../../../argocd/applications/agents-ci/runner-rbac-cluster.yaml', import.meta.url),
  'utf8',
)
const arcApplication = readFileSync(
  new URL('../../../../../argocd/applications/arc/application.yaml', import.meta.url),
  'utf8',
)
const arcKubeModeServiceAccount = readFileSync(
  new URL('../../../../../argocd/applications/arc/kube-mode-serviceaccount.yaml', import.meta.url),
  'utf8',
)

describe('torghut post-deploy verifier workflow', () => {
  it('observes the Kargo promotion and keeps Argo revision verification read-only', () => {
    const pushTrigger = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_dispatch:'))
    expect(pushTrigger).toContain('- kargo/torghut')
    expect(pushTrigger).not.toContain('- main')
    expect(pushTrigger).toContain("- 'argocd/applications/torghut/**'")
    expect(workflow).toContain('git merge-base --is-ancestor "${EXPECTED_REVISION}" "${candidate}"')
    expect(workflow).toContain('contents: read')
    expect(workflow).toContain('argocd-update step owns the sync')
    expect(workflow).not.toContain('kubectl patch application')
    expect(workflow).not.toContain('kubectl annotate application')
    expect(workflow).not.toContain('contents: write')
    expect(workflow).toContain('ARGO_SYNC_TIMEOUT_SECONDS=1800')
    expect(workflow).toContain('dump_argocd_app_diagnostics "${app}"')
  })

  it('checks retained deployments and both Flink jobs without contacting retired APIs', () => {
    expect(workflow).toContain(
      'for deployment in \\\n            torghut-ta \\\n            market-data-archive \\\n            torghut-ws; do',
    )
    expect(workflow).toContain('for pipeline in torghut-ta market-data-archive; do')
    expect(workflow).toContain('kubectl rollout status "deployment/${deployment}"')
    expect(workflow).not.toContain('wait_knative_service_ready')
    expect(workflow).not.toContain('http://torghut.torghut.svc.cluster.local')
    expect(workflow).not.toContain('http://torghut-sim.torghut.svc.cluster.local')
    expect(workflow).not.toContain('post-deploy-evidence.ts')
    expect(workflow).toContain('ImagePullBackOff')
    expect(workflow).toContain('ErrImagePull')
  })

  const removalCheck = workflow.slice(
    workflow.indexOf('          for removal_attempt in $(seq 1 30); do'),
    workflow.indexOf('          for deployment in'),
  )
  const emptyInventory = { status: { resources: [] } }
  const emptyPods = { items: [] }
  const removalCases: Array<[string, string, string, unknown, unknown, number, boolean]> = [
    ['all retired resources absent', '', '', emptyInventory, emptyPods, 0, true],
    ['scaled-down Deployment remains', 'deployment.apps/torghut-ta-sim', '', emptyInventory, emptyPods, 0, false],
    ['scale-to-zero API remains', '', 'service.serving.knative.dev/torghut', emptyInventory, emptyPods, 0, false],
    ['Argo inventory is missing', '', '', {}, emptyPods, 0, false],
    ['cluster access denied', '', '', emptyInventory, emptyPods, 1, false],
    [
      'retained pipeline pods',
      '',
      '',
      emptyInventory,
      {
        items: ['torghut-ta-123', 'market-data-archive-123', 'torghut-ws-123', 'chi-torghut-clickhouse-0-0'].map(
          (name) => ({ metadata: { name } }),
        ),
      },
      0,
      true,
    ],
    [
      'recovery objects retained',
      '',
      '',
      {
        status: {
          resources: [
            { kind: 'PersistentVolumeClaim', namespace: 'torghut', name: 'torghut-db' },
            { kind: 'Backup', namespace: 'torghut', name: 'torghut-db-retirement-20260912' },
          ],
        },
      },
      emptyPods,
      0,
      true,
    ],
  ]
  for (const [kind, name] of [
    ['Cluster', 'torghut-db'],
    ['TigerBeetleCluster', 'torghut-tigerbeetle'],
    ['FlinkDeployment', 'torghut-ta-sim'],
    ['Service', 'torghut'],
    ['Deployment', 'torghut-llm-guardrails-exporter'],
    ['CronJob', 'torghut-order-lineage-reconciliation'],
    ['ScheduledBackup', 'torghut-db-daily'],
  ]) {
    removalCases.push([
      `Argo still tracks ${kind}/${name}`,
      '',
      '',
      { status: { resources: [{ kind, name, namespace: 'torghut' }] } },
      emptyPods,
      0,
      false,
    ])
  }
  for (const name of [
    'torghut-01573-deployment-abc',
    'torghut-sim-01645-deployment-abc',
    'torghut-db-1',
    'torghut-tigerbeetle-0',
    'torghut-ta-sim-taskmanager-1-1',
    'torghut-llm-guardrails-exporter-abc',
    'torghut-scheduler-abc',
  ]) {
    removalCases.push([
      `${name} still terminating`,
      '',
      '',
      emptyInventory,
      { items: [{ metadata: { name, deletionTimestamp: '2026-09-12T00:00:00Z' } }] },
      0,
      false,
    ])
  }
  for (const [name, deployments, apis, inventory, pods, exitCode, succeeds] of removalCases) {
    it(`checks retirement when ${name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'torghut-retirement-test-'))
      try {
        const result = Bun.spawnSync(
          [
            'bash',
            '-euo',
            'pipefail',
            '-c',
            `
          sleep() { :; }
          kubectl() {
            if [ "$TEST_EXIT_CODE" != '0' ]; then return "$TEST_EXIT_CODE"; fi
            case "$2" in
              deployment) printf '%s' "$TEST_DEPLOYMENTS" ;;
              ksvc) printf '%s' "$TEST_APIS" ;;
              application) printf '%s' "$TEST_INVENTORY" ;;
              pods) printf '%s' "$TEST_PODS" ;;
              *) return 99 ;;
            esac
          }
          ${removalCheck}
        `,
          ],
          {
            env: {
              ...process.env,
              EVIDENCE_DIR: directory,
              TEST_DEPLOYMENTS: deployments,
              TEST_APIS: apis,
              TEST_INVENTORY: JSON.stringify(inventory),
              TEST_PODS: JSON.stringify(pods),
              TEST_EXIT_CODE: String(exitCode),
            },
          },
        )
        expect(result.exitCode === 0).toBe(succeeds)
        if (succeeds) expect(result.stdout.toString()).toContain('Retired Torghut workloads and pods are absent')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  const pipelineCheck = workflow.slice(
    workflow.indexOf('          for pipeline in'),
    workflow.indexOf('      - name: Verify market-data freshness'),
  )
  for (const [name, jobs, checkpoints, succeeds] of [
    [
      'running with checkpoint',
      { jobs: [{ jid: 'abc', state: 'RUNNING', tasks: { total: 4, running: 4, finished: 0, failed: 0 } }] },
      { latest: { completed: { status: 'COMPLETED', id: 42 } } },
      true,
    ],
    [
      'completed bounded source',
      { jobs: [{ jid: 'abc', state: 'RUNNING', tasks: { total: 83, running: 82, finished: 1, failed: 0 } }] },
      { latest: { completed: { status: 'COMPLETED', id: 42 } } },
      true,
    ],
    [
      'unaccounted task',
      { jobs: [{ jid: 'abc', state: 'RUNNING', tasks: { total: 4, running: 3, finished: 0, failed: 0 } }] },
      { latest: { completed: { status: 'COMPLETED', id: 42 } } },
      false,
    ],
    ['no job', { jobs: [] }, { latest: {} }, false],
    [
      'failed task',
      { jobs: [{ jid: 'abc', state: 'RUNNING', tasks: { total: 4, running: 3, finished: 0, failed: 1 } }] },
      { latest: { completed: { status: 'COMPLETED', id: 42 } } },
      false,
    ],
    [
      'no checkpoint',
      { jobs: [{ jid: 'abc', state: 'RUNNING', tasks: { total: 4, running: 4, finished: 0, failed: 0 } }] },
      { latest: {} },
      false,
    ],
  ] as const) {
    it(`validates native Flink evidence when ${name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'torghut-pipeline-test-'))
      try {
        const result = Bun.spawnSync(
          [
            'bash',
            '-euo',
            'pipefail',
            '-c',
            `
          sleep() { :; }
          curl() {
            local url="" output=""
            while [ "$#" -gt 0 ]; do
              case "$1" in http*) url="$1" ;; -o) shift; output="$1" ;; esac
              shift
            done
            case "$url" in */overview) printf '%s' "$TEST_JOBS" > "$output" ;;
              */checkpoints) printf '%s' "$TEST_CHECKPOINTS" > "$output" ;; *) return 99 ;; esac
          }
          ${pipelineCheck}
        `,
          ],
          {
            env: {
              ...process.env,
              EVIDENCE_DIR: directory,
              TEST_JOBS: JSON.stringify(jobs),
              TEST_CHECKPOINTS: JSON.stringify(checkpoints),
            },
          },
        )
        expect(result.exitCode === 0).toBe(succeeds)
        if (succeeds)
          expect(result.stdout.toString()).toContain(
            'market-data-archive: job RUNNING, tasks running or finished, checkpoint completed',
          )
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  it('keeps Kafka, websocket, and TA freshness checks with bounded retries', () => {
    expect(workflow).toContain('MARKET_DATA_FRESHNESS_MODE: auto')
    expect(workflow).toContain("TORGHUT_SCHEDULER_EXPECTED: 'false'")
    expect(workflow).toContain('bun run smoke:torghut-market-data')
    expect(workflow).toContain('TA_FRESHNESS_ATTEMPTS=4')
    expect(workflow).toContain('TA_FRESHNESS_INTERVAL_SECONDS=30')
    expect(workflow).toContain('waiting for the next TA heartbeat')
    expect(workflow).not.toContain("KAFKA_TOPIC_PARTITIONS: '0,1,2'")
  })

  it('grants the ARC runner read access to Torghut post-deploy resources', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-post-deploy-read')
    expect(agentsCiClusterRbac).toContain('serving.knative.dev')
    expect(agentsCiClusterRbac).toContain('resources:\n      - pods')
    expect(agentsCiClusterRbac).toContain('arc-arm64-gha-rs-kube-mode')
  })

  it('grants the ARC runner only the extra Kubernetes access needed for market-data smoke', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-market-data-read')
    expect(agentsCiClusterRbac).toContain('kind: Role')
    expect(agentsCiClusterRbac).toContain('kind: RoleBinding')
    expect(agentsCiClusterRbac).toContain('namespace: torghut')
    expect(agentsCiClusterRbac).toContain('resourceNames:\n      - torghut-ws')
    expect(agentsCiClusterRbac).toContain('resources:\n      - configmaps')
    expect(agentsCiClusterRbac).toContain('resourceNames:\n      - torghut-ta-config')
    expect(agentsCiClusterRbac).toContain('resources:\n      - pods')
    expect(agentsCiClusterRbac).toContain('resources:\n      - pods/exec')
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-kafka-tail')
    expect(agentsCiClusterRbac).toContain('namespace: kafka')
    expect(agentsCiClusterRbac).not.toContain('kind: ClusterRole\nmetadata:\n  name: agents-ci-runner-kafka-tail')
    expect(agentsCiClusterRbac).not.toContain(
      'kind: ClusterRoleBinding\nmetadata:\n  name: agents-ci-runner-kafka-tail',
    )
    expect(agentsCiClusterRbac).not.toContain(
      'kind: ClusterRole\nmetadata:\n  name: agents-ci-runner-torghut-market-data-read',
    )
    expect(agentsCiClusterRbac).not.toContain(
      'kind: ClusterRoleBinding\nmetadata:\n  name: agents-ci-runner-torghut-market-data-read',
    )
  })

  it('runs arm64 workflows with the kube-mode service account that receives post-deploy RBAC', () => {
    expect(arcApplication).toContain('runnerScaleSetName: arc-arm64')
    expect(arcApplication).toContain('serviceAccountName: arc-arm64-gha-rs-kube-mode')
    expect(arcKubeModeServiceAccount).toContain('kind: ServiceAccount')
    expect(arcKubeModeServiceAccount).toContain('name: arc-arm64-gha-rs-kube-mode')
    expect(arcKubeModeServiceAccount).toContain('namespace: arc')
  })

  it('keeps ARC runner Argo access read-only', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-argocd-verify-read')
    expect(agentsCiClusterRbac).toContain('argoproj.io')
    expect(agentsCiClusterRbac).not.toContain('agents-ci-runner-argocd-application-refresh')
  })
})
