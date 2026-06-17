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

  it('retries database-timeout readyz 503 payloads until they match the repair-only contract', () => {
    expect(workflow).toContain('fetch_readyz_json()')
    expect(workflow).toContain('packages/scripts/src/torghut/readyz-contract.ts')
    expect(workflow).toContain('retryable_database_timeout')
    expect(workflow).toContain('database readiness timed out; retrying')
    expect(workflow).toContain('without an acceptable readyz contract')
    expect(workflow).toContain('fetch_readyz_json \\')
  })

  it('retries Knative service JSON evidence capture before invoking the validator', () => {
    expect(workflow).toContain('fetch_json()')
    expect(workflow).toContain('python3 -m json.tool "${output_path}"')
    expect(workflow).toContain('not usable JSON yet; retrying')
    expect(workflow).toContain('fetch_json_2xx')
    expect(workflow).toContain('Torghut sim /trading/proofs')
    expect(workflow).not.toContain('curl -fsS http://torghut.torghut.svc.cluster.local/trading/status')
  })

  it('retries parseable non-2xx deploy evidence before failing', () => {
    expect(workflow).toContain('Attempt ${attempt}: ${label} returned HTTP ${status}; expected 2xx; retrying')
    expect(workflow).toContain('did not return a parseable JSON HTTP 2xx response')
    expect(workflow).not.toContain('status="$(fetch_json "${url}" "${output_path}" "${label}")"')
  })

  it('verifies torghut-sim paper-route target mirroring after deploy', () => {
    expect(workflow).toContain('Knative Service torghut-sim is not Ready')
    expect(workflow).toContain('http://torghut.torghut.svc.cluster.local/trading/proofs')
    expect(workflow).toContain('http://torghut-sim.torghut.svc.cluster.local/trading/proofs')
    expect(workflow).toContain('TORGHUT_SIM_PAPER_ROUTE_EVIDENCE')
  })

  it('retries transient sim paper-route target mirror gaps before rollback', () => {
    expect(workflow).toContain('validate_post_deploy_evidence()')
    expect(workflow).toContain('post-deploy-evidence-validator.out')
    expect(workflow).toContain(
      'torghut-sim paper-route target plan (is empty while live torghut exposes targets|missing live target)',
    )
    expect(workflow).toContain(
      'Torghut sim paper-route target mirror not materialized yet; refreshing evidence payloads',
    )
    expect(workflow).toContain('Torghut sim paper-route target mirror did not materialize after bounded retry window')
  })

  it('requests Argo refresh before polling deployed revisions', () => {
    expect(workflow).toContain('argocd.argoproj.io/refresh=hard --overwrite')
    expect(workflow).toContain('for app in torghut torghut-options; do')
  })

  it('fails when Torghut-managed images still have pull errors', () => {
    expect(workflow).toContain('ImagePullBackOff')
    expect(workflow).toContain('ErrImagePull')
    expect(workflow).toContain('startswith("registry.ide-newton.ts.net/lab/torghut")')
    expect(workflow).toContain('Torghut-managed image pull failures remain after deploy')
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

  it('closes superseded automatic rollback pull requests after successful verification', () => {
    expect(workflow).toContain('Close superseded Torghut rollback pull requests')
    expect(workflow).toContain("success() && github.event_name == 'push' && github.ref == 'refs/heads/main'")
    expect(workflow).toContain('uses: actions/github-script@v8')
    expect(workflow).toContain('codex/torghut-rollback-')
    expect(workflow).toContain('revert(torghut): rollback failed promotion ')
    expect(workflow).toContain('github.paginate(github.rest.pulls.list')
    expect(workflow).toContain('github.rest.pulls.update')
    expect(workflow).toContain('github.rest.git.deleteRef')
    expect(workflow).not.toContain('gh pr close')
  })

  it('closes older automatic rollback pull requests before opening a new failed-promotion rollback', () => {
    expect(workflow).toContain('Close older failed-promotion rollback pull requests')
    expect(workflow).toContain("failure() && steps.rollback.outputs.should_rollback == 'true'")
    expect(workflow).toContain(
      'CURRENT_ROLLBACK_BRANCH: codex/torghut-rollback-${{ github.run_id }}-${{ github.run_attempt }}',
    )
    expect(workflow).toContain('pr.head.ref !== currentBranch')
    expect(workflow).toContain('because a newer failed promotion rollback is being opened')
    expect(workflow).not.toContain('gh pr list -R "${GH_REPO}"')
  })

  it('does not open rollback pull requests for stale main push verifiers', () => {
    expect(workflow).toContain('MAIN_HEAD="$(git rev-parse origin/main)"')
    expect(workflow).toContain('Skipping rollback PR because main advanced from ${GITHUB_SHA} to ${MAIN_HEAD}')
    expect(workflow).toContain('echo "should_rollback=false" >> "$GITHUB_OUTPUT"')
  })
})
