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

  it('delegates readyz acceptance to the revenue repair evidence validator', () => {
    expect(workflow).toContain('TORGHUT_READYZ_HTTP_STATUS')
    expect(workflow).toContain('TORGHUT_READYZ_PAYLOAD="${EVIDENCE_DIR}/torghut-readyz.json"')
    expect(workflow).toContain('bun run packages/scripts/src/torghut/post-deploy-evidence.ts')
    expect(workflow).not.toContain('Torghut /readyz returned HTTP')
  })

  it('runs market-data freshness verification after deploy evidence is accepted', () => {
    expect(workflow).toContain('Verify market-data freshness')
    expect(workflow).toContain('MARKET_DATA_FRESHNESS_MODE: auto')
    expect(workflow).toContain("MARKET_DATA_MAX_LAG_SECONDS: '300'")
    expect(workflow).toContain("MARKET_DATA_ACCEPTED_MAX_LAG_SECONDS: '300'")
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
  })

  it('retries Knative service JSON evidence capture before invoking the validator', () => {
    expect(workflow).toContain('fetch_json()')
    expect(workflow).toContain('python3 -m json.tool "${output_path}"')
    expect(workflow).toContain('not usable JSON yet; retrying')
    expect(workflow).toContain('fetch_json_2xx')
    expect(workflow).toContain('fetch_json_2xx_optional')
    expect(workflow).toContain('Torghut sim /trading/proofs')
    expect(workflow).not.toContain('curl -fsS http://torghut.torghut.svc.cluster.local/trading/status')
  })

  it('retries parseable non-2xx deploy evidence before failing', () => {
    expect(workflow).toContain('Attempt ${attempt}: ${label} returned HTTP ${status}; expected 2xx; retrying')
    expect(workflow).toContain('did not return a parseable JSON HTTP 2xx response')
    expect(workflow).toContain('HTTP_MAX_TIME_SECONDS=15')
    expect(workflow).toContain('JSON_EVIDENCE_ATTEMPTS=3')
    expect(workflow).toContain('--max-time "${HTTP_MAX_TIME_SECONDS}"')
    expect(workflow).not.toContain('status="$(fetch_json "${url}" "${output_path}" "${label}")"')
    expect(workflow).not.toContain('--max-time 90')
  })

  it('verifies torghut-sim paper-route target mirroring after deploy', () => {
    expect(workflow).toContain('wait_knative_service_ready torghut-sim')
    expect(workflow).toContain('http://torghut.torghut.svc.cluster.local/trading/proofs')
    expect(workflow).toContain('http://torghut-sim.torghut.svc.cluster.local/trading/proofs')
    expect(workflow).toContain('TORGHUT_SIM_PAPER_ROUTE_EVIDENCE')
    expect(workflow).toContain('capture_paper_route_mirror_evidence()')
    expect(workflow).toContain('validate_post_deploy_evidence_with_mirror_retry')
  })

  it('keeps slow paper-route proof endpoints from failing otherwise healthy rollouts', () => {
    expect(workflow).toContain('Torghut /trading/revenue-repair')
    expect(workflow).toContain('fetch_json_2xx \\')
    expect(workflow).toContain('fetch_json_2xx_optional()')
    expect(workflow).toContain('PAPER_ROUTE_EVIDENCE_ATTEMPTS=1')
    expect(workflow).toContain('PAPER_ROUTE_HTTP_MAX_TIME_SECONDS=8')
    expect(workflow).toContain('--max-time "${PAPER_ROUTE_HTTP_MAX_TIME_SECONDS}"')
    expect(workflow).toContain(
      'Paper-route mirror evidence unavailable; hard rollout, image-pull, readyz, status, and revenue-repair gates passed',
    )
    expect(workflow).toContain('unavailable after bounded optional evidence retry')
    expect(workflow).toContain('unset TORGHUT_PAPER_ROUTE_EVIDENCE')
    expect(workflow).toContain('unset TORGHUT_SIM_PAPER_ROUTE_EVIDENCE')
    expect(workflow).toContain('run_post_deploy_evidence_validator')
  })

  it('retries transient sim paper-route target mirror gaps before failing verification', () => {
    expect(workflow).toContain('validate_post_deploy_evidence_with_mirror_retry()')
    expect(workflow).toContain('post-deploy-evidence-validator.out')
    expect(workflow).toContain(
      'torghut-sim paper-route target plan (is empty while live torghut exposes targets|missing live target)',
    )
    expect(workflow).toContain(
      'Torghut sim paper-route target mirror not materialized yet; refreshing evidence payloads',
    )
    expect(workflow).toContain('Torghut sim paper-route target mirror did not materialize after bounded retry window')
    expect(workflow).toContain('SIM_MIRROR_ATTEMPTS=12')
    expect(workflow).toContain('SIM_MIRROR_RETRY_INTERVAL_SECONDS=5')
    expect(workflow).not.toContain('sleep 10')
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

  it('grants the ARC runner only the extra Kubernetes access needed for market-data Kafka smoke', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-market-data-secret-read')
    expect(agentsCiClusterRbac).toContain('namespace: torghut')
    expect(agentsCiClusterRbac).toContain('resourceNames:\n      - torghut-ws')
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-kafka-tail')
    expect(agentsCiClusterRbac).toContain('namespace: kafka')
    expect(agentsCiClusterRbac).toContain('resources:\n      - pods/exec')
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
