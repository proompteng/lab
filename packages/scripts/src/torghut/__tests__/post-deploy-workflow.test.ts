import { readFileSync } from 'node:fs'

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
  it('does not skip Knative Service readiness when the runner lacks RBAC', () => {
    expect(workflow).not.toContain('Skipping Knative Service readiness check')
    expect(workflow).toContain('Failed to read Knative Service ${service}')
  })

  it('polls Knative Service readiness after Argo applies a new revision', () => {
    expect(workflow).toContain('wait_knative_service_ready()')
    expect(workflow).toContain('KNSVC_READY_ATTEMPTS=60')
    expect(workflow).toContain('KNSVC_READY_INTERVAL_SECONDS=2')
    expect(workflow).toContain('wait_knative_service_ready torghut')
    expect(workflow).toContain('wait_knative_service_ready torghut-sim')
    expect(workflow).toContain(
      'Attempt ${attempt}: Knative Service ${service} ready=${ready:-empty} latestReady=${latest_ready:-empty} latestCreated=${latest_created:-empty}',
    )
    expect(workflow).toContain('Knative Service ${service} did not become Ready after bounded retry window')
    expect(workflow).not.toContain('KNSVC_READY_STATUS=$?')
    expect(workflow).not.toContain('SIM_KNSVC_READY_STATUS=$?')
  })

  it('uses a shell-safe jsonpath for Knative Service readiness', () => {
    expect(workflow).toContain(
      `jsonpath='{.status.conditions[?(@.type=="Ready")].status} {.status.latestReadyRevisionName} {.status.latestCreatedRevisionName}'`,
    )
    expect(workflow).not.toContain(`jsonpath='{.status.conditions[?(@.type==\\"Ready\\")].status}'`)
  })

  it('continues to runtime safety checks when Torghut Argo health is degraded after sync', () => {
    expect(workflow).toContain('Torghut Argo health is Degraded after sync; continuing to runtime safety checks')
    expect(workflow).toContain('[ "${app}" = \'torghut\' ]')
    expect(workflow).toContain('[ "${OPERATION_PHASE}" = \'Succeeded\' ]')
  })

  it('verifies options, TA, and websocket deployments after Torghut GitOps changes', () => {
    expect(workflow).toContain("- 'argocd/applications/torghut-options/**'")
    expect(workflow).toContain('for app in torghut torghut-options; do')
    expect(workflow).toContain('kubectl rollout status "deployment/${deployment}"')
    expect(workflow).toContain('torghut-options-catalog')
    expect(workflow).toContain('torghut-options-enricher')
    expect(workflow).toContain('torghut-options-ta')
    expect(workflow).toContain('torghut-ta')
    expect(workflow).toContain('torghut-ta-sim')
    expect(workflow).toContain('torghut-ws')
    expect(workflow).toContain('torghut-ws-options')
  })

  it('delegates distinct API, scheduler, and status evidence to the runtime contract validator', () => {
    expect(workflow).toContain('TORGHUT_SCHEDULER_REPLICAS')
    expect(workflow).toContain('TORGHUT_API_READYZ_HTTP_STATUS')
    expect(workflow).toContain('TORGHUT_SCHEDULER_READYZ_HTTP_STATUS')
    expect(workflow).toContain('TORGHUT_STATUS_HTTP_STATUS')
    expect(workflow).toContain('TORGHUT_API_READYZ_PAYLOAD="${EVIDENCE_DIR}/torghut-api-readyz.json"')
    expect(workflow).toContain('TORGHUT_SCHEDULER_READYZ_PAYLOAD="${EVIDENCE_DIR}/torghut-scheduler-readyz.json"')
    expect(workflow).toContain('TORGHUT_STATUS_PAYLOAD="${EVIDENCE_DIR}/torghut-status.json"')
    expect(workflow).toContain('bun run packages/scripts/src/torghut/post-deploy-evidence.ts')
    expect(workflow).not.toContain('/trading/revenue-repair')
    expect(workflow).not.toContain('/trading/proofs')
  })

  it('reads and bounds the live scheduler replica count after Argo convergence', () => {
    const replicaRead = workflow.indexOf(
      "kubectl get deployment torghut-scheduler -n torghut -o jsonpath='{.spec.replicas}'",
    )
    const argoWait = workflow.indexOf('for app in torghut torghut-options; do')

    expect(replicaRead).toBeGreaterThan(argoWait)
    expect(workflow).toContain('case "${TORGHUT_SCHEDULER_REPLICAS}" in')
    expect(workflow).toContain('0 | 1)')
    expect(workflow).toContain(
      'Torghut scheduler replicas must be exactly 0 or 1; got ${TORGHUT_SCHEDULER_REPLICAS:-unset}',
    )
    expect(workflow).toContain('if [ "${TORGHUT_SCHEDULER_REPLICAS}" = \'1\' ]; then')
    expect(workflow).toContain('kubectl rollout status deployment/torghut-scheduler -n torghut --timeout=10m')
  })

  it('runs market-data freshness verification after deploy evidence is accepted', () => {
    expect(workflow).toContain('Verify market-data freshness')
    expect(workflow).toContain('MARKET_DATA_FRESHNESS_MODE: auto')
    expect(workflow).toContain("MARKET_DATA_MAX_LAG_SECONDS: '300'")
    expect(workflow).toContain("MARKET_DATA_ACCEPTED_MAX_LAG_SECONDS: '300'")
    expect(workflow).toContain(
      "MARKET_DATA_HOLIDAYS: '2026-01-01,2026-01-19,2026-02-16,2026-04-03,2026-05-25,2026-06-19,2026-07-03,2026-09-07,2026-11-26,2026-12-25,2027-01-01,2027-01-18,2027-02-15,2027-03-26,2027-05-31,2027-06-18,2027-07-05,2027-09-06,2027-11-25,2027-12-24,2027-12-31,2028-01-17,2028-02-21,2028-04-14,2028-05-29,2028-06-19,2028-07-04,2028-09-04,2028-11-23,2028-12-25'",
    )
    expect(workflow).toContain("MARKET_DATA_PRINT_SUMMARIES: 'false'")
    expect(workflow).not.toContain("KAFKA_TOPIC_PARTITIONS: '0,1,2'")
    expect(workflow).toContain('bun run smoke:torghut-market-data')
  })

  it('retries database-timeout readyz 503 payloads until they match an accepted readyz contract', () => {
    expect(workflow).toContain('fetch_readyz_json()')
    expect(workflow).toContain('packages/scripts/src/torghut/readyz-contract.ts')
    expect(workflow).toContain('retryable_database_timeout')
    expect(workflow).toContain('database readiness timed out; retrying')
    expect(workflow).toContain('without an acceptable readyz contract')
    expect(workflow).toContain('READYZ_EVIDENCE_ATTEMPTS=12')
    expect(workflow).toContain('fetch_readyz_json \\')
    expect(workflow).toContain('http://torghut-scheduler.torghut.svc.cluster.local:8183/readyz')
  })

  it('always captures stable API readiness and conditionally captures scheduler readiness', () => {
    const apiCapture = workflow.indexOf('TORGHUT_API_READYZ_HTTP_STATUS="$(')
    const schedulerCondition = workflow.indexOf('if [ "${TORGHUT_SCHEDULER_REPLICAS}" = \'1\' ]; then', apiCapture)
    const schedulerCapture = workflow.indexOf('TORGHUT_SCHEDULER_READYZ_HTTP_STATUS="$(')
    const schedulerConditionEnd = workflow.indexOf('\n          fi', schedulerCapture)

    expect(apiCapture).toBeGreaterThan(-1)
    expect(workflow).toContain('http://torghut.torghut.svc.cluster.local/readyz')
    expect(schedulerCondition).toBeGreaterThan(apiCapture)
    expect(schedulerCapture).toBeGreaterThan(schedulerCondition)
    expect(schedulerConditionEnd).toBeGreaterThan(schedulerCapture)
    expect(workflow).not.toContain('touch "${EVIDENCE_DIR}/torghut-scheduler-readyz.json"')
  })

  it('retries parseable JSON evidence capture before invoking the validator', () => {
    expect(workflow).toContain('fetch_json()')
    expect(workflow).toContain('python3 -m json.tool "${output_path}"')
    expect(workflow).toContain('not usable JSON yet; retrying')
    expect(workflow).not.toContain('fetch_json_2xx')
    expect(workflow).not.toContain('curl -fsS http://torghut.torghut.svc.cluster.local/trading/status')
  })

  it('captures the trading status HTTP code for mode-aware validation without requiring 2xx', () => {
    expect(workflow).toContain('TORGHUT_STATUS_HTTP_STATUS="$(')
    expect(workflow).toContain('http://torghut.torghut.svc.cluster.local/trading/status')
    expect(workflow).toContain('export TORGHUT_STATUS_HTTP_STATUS')
    expect(workflow).toContain('Torghut /trading/status HTTP ${TORGHUT_STATUS_HTTP_STATUS}')
    expect(workflow).toContain('HTTP_MAX_TIME_SECONDS=15')
    expect(workflow).toContain('JSON_EVIDENCE_ATTEMPTS=3')
    expect(workflow).toContain('--max-time "${HTTP_MAX_TIME_SECONDS}"')
    expect(workflow).not.toContain('fetch_json_2xx')
    expect(workflow).not.toContain('expected 2xx')
    expect(workflow).not.toContain('--max-time 90')
  })

  it('keeps simulation rollout readiness without obsolete paper-route evidence', () => {
    expect(workflow).toContain('wait_knative_service_ready torghut-sim')
    expect(workflow).not.toContain('PAPER_ROUTE_EVIDENCE')
    expect(workflow).not.toContain('SIM_MIRROR')
  })

  it('requests explicit Argo sync before polling deployed revisions', () => {
    expect(workflow).toContain('argocd.argoproj.io/refresh=hard --overwrite')
    expect(workflow).toContain('request_argocd_sync()')
    expect(workflow).toContain('{"prune": True}')
    expect(workflow).toContain('kubectl patch application "${app}" -n argocd --type merge -p "${payload}"')
    expect(workflow).toContain('for app in torghut torghut-options; do')
  })

  it('bounds Argo convergence waits and prints resource diagnostics on timeout', () => {
    expect(workflow).toContain('ARGO_SYNC_POLL_ATTEMPTS=150')
    expect(workflow).toContain('ARGO_SYNC_POLL_INTERVAL_SECONDS=2')
    expect(workflow).toContain('for attempt in $(seq 1 "${ARGO_SYNC_POLL_ATTEMPTS}"); do')
    expect(workflow).toContain('sleep "${ARGO_SYNC_POLL_INTERVAL_SECONDS}"')
    expect(workflow).toContain(
      'Argo application ${app} sync operation succeeded while health is Progressing; runtime checks will verify readiness',
    )
    expect(workflow).toContain('dump_argocd_app_diagnostics "${app}"')
    expect(workflow).toContain('Argo application ${app} OutOfSync resources:')
  })

  it('fails when Torghut-managed images still have pull errors', () => {
    expect(workflow).toContain('ImagePullBackOff')
    expect(workflow).toContain('ErrImagePull')
    expect(workflow).toContain('startswith("registry.ide-newton.ts.net/lab/torghut")')
    expect(workflow).toContain('Torghut-managed image pull failures remain after deploy')
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

  it('grants the ARC runner patch access for explicit Argo refreshes', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-argocd-application-refresh')
    expect(agentsCiClusterRbac).toContain('argoproj.io')
    expect(agentsCiClusterRbac).toContain('patch')
  })
})
