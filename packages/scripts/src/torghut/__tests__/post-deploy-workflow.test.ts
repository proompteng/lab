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
const optionsTaConfigmap = readFileSync(
  new URL('../../../../../argocd/applications/torghut-options/ta/configmap.yaml', import.meta.url),
  'utf8',
)
const optionsTaFlinkDeployment = readFileSync(
  new URL('../../../../../argocd/applications/torghut-options/ta/flinkdeployment.yaml', import.meta.url),
  'utf8',
)

describe('torghut post-deploy verifier workflow', () => {
  it('does not skip Knative Service readiness when the runner lacks RBAC', () => {
    expect(workflow).not.toContain('Skipping Knative Service readiness check')
    expect(workflow).toContain('Failed to read Knative Service torghut')
  })

  it('uses a shell-safe jsonpath for Knative Service readiness', () => {
    expect(workflow).toContain(`jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`)
    expect(workflow).not.toContain(`jsonpath='{.status.conditions[?(@.type==\\"Ready\\")].status}'`)
  })

  it('continues to runtime safety checks when Torghut Argo health is degraded after sync', () => {
    expect(workflow).toContain('Torghut Argo health is Degraded after sync; continuing to runtime safety checks')
    expect(workflow).toContain('[ "${app}" = \'torghut\' ]')
    expect(workflow).toContain('[ "${OPERATION_PHASE}" = \'Succeeded\' ]')
  })

  it('continues past degraded Torghut options Argo health only with explicit workload rollout checks', () => {
    expect(workflow).toContain(
      'Torghut options Argo health is Degraded after sync; continuing to explicit workload rollout checks',
    )
    expect(workflow).toContain('[ "${app}" = \'torghut-options\' ]')
    expect(workflow).toContain('kubectl rollout status deployment/torghut-options-catalog -n torghut --timeout=10m')
    expect(workflow).toContain('kubectl rollout status deployment/torghut-options-enricher -n torghut --timeout=10m')
    expect(workflow).toContain('kubectl rollout status deployment/torghut-ws-options -n torghut --timeout=10m')
  })

  it('delegates readyz acceptance to the revenue repair evidence validator', () => {
    expect(workflow).toContain('TORGHUT_READYZ_HTTP_STATUS')
    expect(workflow).toContain('TORGHUT_READYZ_PAYLOAD="${EVIDENCE_DIR}/torghut-readyz.json"')
    expect(workflow).toContain('bun run packages/scripts/src/torghut/post-deploy-evidence.ts')
    expect(workflow).not.toContain('Torghut /readyz returned HTTP')
  })

  it('retries Knative service JSON evidence capture before invoking the validator', () => {
    expect(workflow).toContain('fetch_json()')
    expect(workflow).toContain('python3 -m json.tool "${output_path}"')
    expect(workflow).toContain('not usable JSON yet; retrying')
    expect(workflow).toContain('fetch_json_2xx')
    expect(workflow).toContain('Torghut sim /trading/paper-route-evidence')
    expect(workflow).not.toContain('curl -fsS http://torghut.torghut.svc.cluster.local/trading/status')
  })

  it('retries parseable non-2xx deploy evidence before failing', () => {
    expect(workflow).toContain('Attempt ${attempt}: ${label} returned HTTP ${status}; expected 2xx; retrying')
    expect(workflow).toContain('did not return a parseable JSON HTTP 2xx response')
    expect(workflow).not.toContain('status="$(fetch_json "${url}" "${output_path}" "${label}")"')
  })

  it('verifies torghut-sim paper-route target mirroring after deploy', () => {
    expect(workflow).toContain('Knative Service torghut-sim is not Ready')
    expect(workflow).toContain('http://torghut.torghut.svc.cluster.local/trading/paper-route-evidence')
    expect(workflow).toContain('http://torghut-sim.torghut.svc.cluster.local/trading/paper-route-evidence')
    expect(workflow).toContain('TORGHUT_SIM_PAPER_ROUTE_EVIDENCE')
  })

  it('requests Argo refresh before polling deployed revisions', () => {
    expect(workflow).toContain('argocd.argoproj.io/refresh=hard --overwrite')
    expect(workflow).toContain('for app in torghut torghut-options; do')
  })

  it('grants the ARC runner read access to Torghut Knative Service readiness', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-torghut-post-deploy-read')
    expect(agentsCiClusterRbac).toContain('serving.knative.dev')
    expect(agentsCiClusterRbac).toContain('arc-arm64-gha-rs-kube-mode')
  })

  it('grants the ARC runner patch access for explicit Argo refreshes', () => {
    expect(agentsCiClusterRbac).toContain('agents-ci-runner-argocd-application-refresh')
    expect(agentsCiClusterRbac).toContain('argoproj.io')
    expect(agentsCiClusterRbac).toContain('patch')
  })

  it('rotates the options TA Kafka transactional client prefix with the restart nonce', () => {
    expect(optionsTaFlinkDeployment).toContain('restartNonce: 9')
    expect(optionsTaConfigmap).toContain('TA_KAFKA_TRANSACTION_TIMEOUT_MS: "120000"')
    expect(optionsTaConfigmap).toContain('TA_CLIENT_ID: "torghut-options-ta-r8"')
    expect(optionsTaConfigmap).toContain('TA_GROUP_ID: "torghut-options-ta-2026-03-08"')
    expect(optionsTaFlinkDeployment).toContain('value: EXACTLY_ONCE')
  })

  it('closes superseded automatic rollback pull requests after successful verification', () => {
    expect(workflow).toContain('Close superseded Torghut rollback pull requests')
    expect(workflow).toContain("success() && github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(workflow).toContain('codex/torghut-rollback-')
    expect(workflow).toContain('revert(torghut): rollback failed promotion ')
    expect(workflow).toContain('gh pr close "${pr_number}" -R "${GH_REPO}" --delete-branch --comment "${comment}"')
  })
})
