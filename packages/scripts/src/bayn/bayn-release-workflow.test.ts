import { readFileSync } from 'node:fs'

import { expect, test } from 'bun:test'

const buildPushWorkflow = readFileSync(
  new URL('../../../../.github/workflows/bayn-build-push.yml', import.meta.url),
  'utf8',
)
const baynCiWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-ci.yml', import.meta.url), 'utf8')
const releaseWorkflow = readFileSync(new URL('../../../../.github/workflows/bayn-release.yml', import.meta.url), 'utf8')
const productApplicationSet = readFileSync(
  new URL('../../../../argocd/applicationsets/product.yaml', import.meta.url),
  'utf8',
)

test('publishes the exact main push SHA without a post-merge review verifier', () => {
  expect(buildPushWorkflow).toContain('branches:\n      - main')
  expect(buildPushWorkflow).toContain('tag: sha-${{ github.sha }}')
  expect(buildPushWorkflow).toContain('source_revision: ${{ github.sha }}')
  expect(buildPushWorkflow).toContain('latest: true')
  expect(buildPushWorkflow).not.toContain('pull-requests:')
  expect(buildPushWorkflow).not.toContain('release-review-eligibility')
  expect(buildPushWorkflow).not.toContain('verify-release-review')
  expect(buildPushWorkflow).not.toContain('schedule:')
  expect(buildPushWorkflow).not.toContain('issue_comment:')
  expect(buildPushWorkflow).not.toContain('workflow_dispatch:')
})

test('keeps the existing Bayn PR gate aggregation', () => {
  expect(baynCiWorkflow).toContain('name: Bayn release gate')
  for (const check of [
    '      - changes',
    '      - pr-checks',
    '      - effect-runtime-compatibility',
    '      - broker-sandbox-contract',
    '      - postgres-integration',
    '      - dependency-input-invariant',
    '      - image',
  ]) {
    expect(baynCiWorkflow).toContain(check)
  }
  expect(baynCiWorkflow).toContain(
    'test-command: bun run --cwd services/bayn tsc && bun run --cwd services/bayn test && bun test packages/scripts/src/bayn',
  )
  expect(baynCiWorkflow).not.toContain('verify-release-review')
})

test('promotes verified main ancestry to an immutable GitOps branch', () => {
  expect(releaseWorkflow).toContain('test "$(git rev-parse HEAD)" = "$source_sha"')
  expect(releaseWorkflow).toContain('test "$(git rev-parse refs/remotes/origin/main)" = "$SOURCE_SHA"')
  expect(releaseWorkflow).toContain('DEPLOYMENT_BRANCH: codex/bayn-deploy')
  expect(releaseWorkflow).toContain(
    'git show "refs/remotes/origin/${DEPLOYMENT_BRANCH}:argocd/applications/bayn/deployment.yaml" > "$deployed_manifest"',
  )
  expect(releaseWorkflow).toContain('--deployed-deployment-path "$deployed_manifest"')
  expect(releaseWorkflow.indexOf('> "$deployed_manifest"')).toBeLessThan(
    releaseWorkflow.indexOf('git merge --no-edit -X theirs "$SOURCE_SHA"'),
  )
  expect(releaseWorkflow).toContain('Main is the reviewed configuration authority')
  expect(releaseWorkflow).toContain('git push origin "HEAD:refs/heads/${DEPLOYMENT_BRANCH}"')
  expect(releaseWorkflow).not.toContain('create-pull-request')
  expect(releaseWorkflow).not.toContain('pull-requests: write')
  expect(releaseWorkflow).not.toContain('git push --force')
})

test('preserves authored research provenance while promoting a strategy-identical reviewed runtime build', () => {
  expect(releaseWorkflow).toContain('test "$activation_kind" = ResearchCapitalActivationRequest')
  expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$authored_source_sha" "$SOURCE_SHA"')
  expect(releaseWorkflow).toContain(
    'research_build_lineage="$(manifest_json_string "$deployment_manifest" BAYN_RESEARCH_CAPITAL_BUILD_LINEAGE)"',
  )
  expect(releaseWorkflow).toContain(
    'authored_source_sha="$(jq -er \'.authoredActivation.sourceRevision\' <<< "$research_build_lineage")"',
  )
  expect(releaseWorkflow).toContain('authored_reference="${authored_image_repository}@${authored_image_digest}"')
  expect(releaseWorkflow).toContain('nix run .#assert-oci-platforms -- "$authored_reference" linux/amd64 linux/arm64')
  expect(releaseWorkflow).toContain(
    'test "$(manifest_value "$deployment_manifest" BAYN_STRATEGY_BEHAVIOR_HASH)" = "$authored_behavior_hash"',
  )
  expect(releaseWorkflow).toContain('test "$strategy_behavior_hash" = "$authored_behavior_hash"')
  expect(releaseWorkflow).toContain('test "$strategy_parameter_hash" = "$authored_parameter_hash"')
  expect(releaseWorkflow).toContain('test "$strategy_name" = "$authored_strategy_name"')
  expect(releaseWorkflow).toContain('test "$strategy_protocol_hash" = "$authored_strategy_protocol_hash"')
  expect(releaseWorkflow).toContain('test "$execution_risk_policy_hash" = "$authored_execution_risk_policy_hash"')
  expect(releaseWorkflow).toContain('strategy_name="$(image_label "$config_amd64" proompteng.ai/bayn.strategy-name)"')
  expect(releaseWorkflow).toContain(
    'strategy_protocol_hash="$(image_label "$config_amd64" proompteng.ai/bayn.strategy-protocol-hash)"',
  )
  expect(releaseWorkflow).toContain(
    'execution_risk_policy_hash="$(image_label "$config_amd64" proompteng.ai/bayn.execution-risk-policy-hash)"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(image_label "$config_arm64" proompteng.ai/bayn.strategy-name)" = "$strategy_name"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(image_label "$config_arm64" proompteng.ai/bayn.strategy-protocol-hash)" = "$strategy_protocol_hash"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(image_label "$config_arm64" proompteng.ai/bayn.execution-risk-policy-hash)" = "$execution_risk_policy_hash"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(manifest_value "$deployment_manifest" BAYN_STRATEGY_NAME)" = "$strategy_name"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(manifest_value "$deployment_manifest" BAYN_STRATEGY_PROTOCOL_HASH)" = "$strategy_protocol_hash"',
  )
  expect(releaseWorkflow).toContain(
    'test "$(manifest_value "$deployment_manifest" BAYN_EXECUTION_RISK_POLICY_HASH)" = "$execution_risk_policy_hash"',
  )
  expect(releaseWorkflow).not.toContain('promotion_source_sha="$authored_source_sha"')
  expect(releaseWorkflow).not.toContain('promotion_image_digest="$authored_image_digest"')
  expect(releaseWorkflow).toContain('promotion_research_lineage_source="$authored_source_sha"')
  expect(releaseWorkflow).toContain(
    'render_arguments+=(--research-lineage-source-sha "$promotion_research_lineage_source")',
  )
  expect(releaseWorkflow).toContain('--source-sha "$promotion_source_sha"')
  expect(releaseWorkflow).toContain('PROMOTED_SOURCE_SHA: ${{ steps.promotion.outputs.promotion_source_sha }}')
})

test('allows the renderer to change only the atomic Bayn deployment manifests', () => {
  for (const path of [
    'argocd/applications/bayn/kustomization.yaml',
    'argocd/applications/bayn/deployment.yaml',
    'argocd/applications/bayn/execution-controller.yaml',
    'argocd/applications/bayn/execution-activation.yaml',
    'argocd/applicationsets/product.yaml',
  ]) {
    expect(releaseWorkflow).toContain(path)
  }
  expect(releaseWorkflow).toContain('unexpected_paths="$(git diff --name-only "$SOURCE_SHA"')
})

test('points only Bayn at the generated deployment branch', () => {
  expect(productApplicationSet).toContain(
    '              - name: bayn\n                path: argocd/applications/bayn\n' +
      "                # Bayn's reviewed main build writes immutable release pins here.",
  )
  expect(productApplicationSet).toContain('                targetRevision: codex/bayn-deploy')
  expect(productApplicationSet).toContain(
    `targetRevision: '{{ if hasKey . "targetRevision" }}{{ .targetRevision }}{{ else }}main{{ end }}'`,
  )
})

test('installs locked manifest renderer dependencies before executing the release renderer', () => {
  const install = 'bun install --frozen-lockfile --ignore-scripts --filter @proompteng/scripts'
  const render = 'bun packages/scripts/src/bayn/update-manifests.ts'
  expect(releaseWorkflow.split(install).length - 1).toBe(1)
  expect(releaseWorkflow.indexOf(install)).toBeLessThan(releaseWorkflow.indexOf(render))
})
