import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const readWorkflow = (name: string) =>
  readFileSync(new URL(`../../../../../.github/workflows/${name}`, import.meta.url), 'utf8')

describe('agents-ci workflow', () => {
  it('is called by the central PR router with its changed-file payload', () => {
    const agentsWorkflow = readWorkflow('agents-ci.yml')
    const pullRequestWorkflow = readWorkflow('pull-request.yml')

    expect(agentsWorkflow).toContain('workflow_call:')
    expect(agentsWorkflow).toContain('changed_files_json:')
    expect(pullRequestWorkflow).toContain("contains(fromJSON(needs.plan.outputs.delegated), 'agents-ci')")
    expect(pullRequestWorkflow).toContain('uses: ./.github/workflows/agents-ci.yml')
    expect(pullRequestWorkflow).toContain('changed_files_json: ${{ needs.plan.outputs.changed_files }}')
  })

  it('keeps cheap validation off ARC and gates integration on it', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('unit:\n    name: Agents typecheck and unit tests\n    needs: plan')
    expect(workflow).toContain('static:\n    name: Validate Agents chart and CRDs\n    needs: plan')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).toContain('integration:\n    name: Agents Kind smoke (${{ needs.plan.outputs.tier }})')
    expect(workflow).toContain('runs-on: arc-amd64')
    expect(workflow).toContain("needs.plan.outputs.run_integration == 'true'")
    expect(workflow).toContain("needs.unit.result == 'success' || needs.unit.result == 'skipped'")
    expect(workflow).toContain("needs.static.result == 'success' || needs.static.result == 'skipped'")
  })

  it('builds selected Nix images in one realization and one Kind preload command', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('Build and preload selected local Nix Agents images')
    expect(workflow).toContain('IMAGE_TARGETS: ${{ needs.plan.outputs.image_targets }}')
    expect(workflow).toContain('installables+=(".#$(image_attr "${target}")")')
    expect(workflow).toContain('run_with_progress \'Nix image build\' 30 nix build --no-link "${installables[@]}"')
    expect(workflow).toContain('nix path-info ".#${package_attr}"')
    expect(workflow).toContain('kind load image-archive --name "${KIND_CLUSTER_NAME}" "${load_archives[@]}"')
    expect(workflow.match(/nix build --no-link/g)).toHaveLength(1)
    expect(workflow.match(/kind load image-archive/g)).toHaveLength(1)
    expect(workflow).not.toContain('docker build')
  })

  it('uses published images for unaffected components without DNS-triggered rebuilding', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('Resolve published Agents images from GitOps values')
    expect(workflow).toContain('Published Agents registry is required for this tier but is not resolvable')
    expect(workflow).toContain('refusing an unrelated local rebuild')
    expect(workflow).not.toContain('registry-unreachable:')
    expect(workflow).not.toContain('AGENTS_IMAGE_MODE="build-local-image"')
  })

  it('does not trigger Agents runtime CI for generic shared JavaScript inputs', () => {
    const workflow = readWorkflow('agents-ci.yml')

    for (const path of ['bun.lock', 'tsconfig.base.json']) {
      expect(workflow).not.toContain(`- '${path}'`)
    }
  })

  it('triggers Agents runtime CI for shared Nix image inputs', () => {
    const workflow = readWorkflow('agents-ci.yml')

    for (const path of [
      'flake.lock',
      'flake.nix',
      'nix/images/agents.nix',
      'nix/images/bun-workspace-service.nix',
      'nix/images/openai-codex-cli.nix',
      'nix/packages.nix',
      'packages/scripts/src/shared/nix-oci-deploy.ts',
    ]) {
      expect(workflow).toContain(`- '${path}'`)
    }
  })

  it('lets the Kind action install its pinned kubectl instead of downloading it twice', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('uses: helm/kind-action@v1')
    expect(workflow).toContain('kubectl_version: v1.29.4')
    expect(workflow).not.toContain('https://dl.k8s.io/release/')
  })
})
