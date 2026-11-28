import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

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

  it('uses all tracked files on merge groups even when the caller passes a changed-file array', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('if [ "${EVENT_NAME}" = merge_group ]; then\n            git ls-files')
    expect(workflow).toContain('elif [ -n "${CHANGED_FILES_JSON}" ]; then')
  })

  it('requires all local smoke images and leaves tailnet credentials on the pull-request path', () => {
    const router = parse(readWorkflow('pull-request.yml'))
    const queue = router.jobs['agents-full']
    expect(router.jobs.agents.if).toContain("github.event_name == 'pull_request'")
    expect(queue).toMatchObject({
      if: "github.event_name == 'merge_group' && needs.plan.result == 'success'",
      uses: './.github/workflows/agents-ci.yml',
    })
    expect(queue).not.toHaveProperty('secrets')
    expect(router.jobs['ci-pr'].needs).toContain('agents-full')

    const workflow = parse(readWorkflow('agents-ci.yml'))
    const integrationSteps: { name: string; if?: string }[] = workflow.jobs.integration.steps
    for (const name of [
      'Connect to the tailnet',
      'Verify internal registry access',
      'Verify internal cache access for local images',
      'Resolve published Agents images from GitOps values',
      'Select published defaults for the smoke test',
      'Configure and verify Kind tailnet access',
    ]) {
      expect(integrationSteps.find((step) => step.name === name)?.if).toContain("github.event_name != 'merge_group'")
    }

    const planSteps: { name: string; run?: string }[] = workflow.jobs.plan.steps
    const guard = planSteps.find((step) => step.name === 'Require the complete queued Agents plan')?.run
    if (!guard) throw new Error('Missing complete Agents plan verification')
    const plan = {
      RUN_UNIT: 'true',
      RUN_STATIC: 'true',
      RUN_INTEGRATION: 'true',
      BUILD_LOCAL: 'true',
      VERIFY_CLOSURE: 'true',
      IMAGE_TARGETS: '["control-plane","controller","runner","agents-shell"]',
    }
    const verify = (outputs: typeof plan) =>
      spawnSync('bash', ['-c', guard], {
        env: { PATH: process.env.PATH, ...outputs },
      }).status
    expect(verify(plan)).toBe(0)
    expect(verify({ ...plan, RUN_STATIC: 'false' })).toBe(1)
    expect(verify({ ...plan, IMAGE_TARGETS: '["control-plane","controller","runner"]' })).toBe(1)
  })

  it('runs validation on hosted runners and schedules independent suites directly from the plan', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('unit:\n    name: Agents typecheck and unit tests\n    needs: plan')
    expect(workflow).toContain('static:\n    name: Validate Agents chart and CRDs\n    needs: plan')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).toContain('integration:\n    name: Agents Kind smoke (${{ needs.plan.outputs.tier }})')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    expect(workflow).not.toContain('runs-on: arc-amd64')
    expect(parse(workflow).jobs.integration).toMatchObject({
      needs: 'plan',
      if: "${{ needs.plan.outputs.run_integration == 'true' }}",
    })
  })

  it('connects the hosted smoke runner before accessing internal images and the Nix cache', () => {
    const workflow = readWorkflow('agents-ci.yml')
    const integration = workflow.slice(workflow.indexOf('\n  integration:'))

    expect(integration).toContain('uses: tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd')
    expect(integration).toContain('oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}')
    expect(integration).toContain('oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}')
    expect(integration).toContain('tags: tag:ci')
    expect(integration.indexOf('Connect to the tailnet')).toBeLessThan(
      integration.indexOf('Verify internal registry access'),
    )
    expect(integration.indexOf('Verify internal cache access for local images')).toBeLessThan(
      integration.indexOf('Set up Nix for selected local Agents images'),
    )
    expect(integration).toContain('https://registry.ide-newton.ts.net/v2/')
    expect(integration).toContain('https://attic.ide-newton.ts.net/lab/nix-cache-info')
    expect(integration).toContain(
      "substituters = ${{ github.event_name != 'merge_group' && 'https://attic.ide-newton.ts.net/lab ' || '' }}https://cache.nixos.org/",
    )
    expect(integration).not.toContain('require-preinstalled:')
    expect(integration).not.toContain('.svc.cluster.local')
  })

  it('builds selected Nix images in one realization and one Kind preload command', () => {
    const workflow = readWorkflow('agents-ci.yml')

    expect(workflow).toContain('Build and preload selected local Nix Agents images')
    expect(workflow).toContain('IMAGE_TARGETS: ${{ needs.plan.outputs.image_targets }}')
    expect(workflow).toContain('installables+=(".#$(image_attr "${target}")")')
    expect(workflow).toContain('run_with_progress \'Nix image build\' 30 nix build --no-link "${installables[@]}"')
    expect(workflow).toContain('nix path-info ".#${package_attr}"')
    expect(workflow).toContain('kind load image-archive --name "${KIND_CLUSTER_NAME}" "${load_archives[@]}"')
    expect(workflow).toContain('agents-shell) echo agents-shell-image')
    expect(workflow).toContain('agents-shell) echo registry.ide-newton.ts.net/lab/agents-shell')
    expect(workflow).toContain('smoke-runner) echo agents-smoke-runner-image')
    expect(workflow).toContain('build_targets=("${targets[@]}" smoke-runner)')
    expect(workflow.match(/nix build --no-link/g)).toHaveLength(1)
    expect(workflow.match(/kind load image-archive/g)).toHaveLength(1)
    expect(workflow).not.toContain('docker build')
  })

  it('always runs lifecycle smoke with the selected slim runner, not the toolchain image', () => {
    const workflow = readWorkflow('agents-ci.yml')
    const steps = parse(workflow).jobs.integration.steps as { name: string; if?: string; run?: string }[]
    const step = (name: string) => steps.find((candidate) => candidate.name === name)
    const selection = step('Select Agents lifecycle smoke runner')
    expect(selection).not.toHaveProperty('if')
    expect(selection?.run).toContain('resolve-smoke-runner-image.ts local')
    expect(selection?.run).toContain('resolve-smoke-runner-image.ts published "${PUBLISHED_SOURCE_SHA}"')
    for (const name of [
      'Set up Nix for selected local Agents images',
      'Build and preload selected local Nix Agents images',
    ]) {
      expect(step(name)?.if).toBe("steps.smoke_runner.outputs.build_local == 'true'")
    }

    const lifecycle = step('Run Agents integration smoke test')
    expect(lifecycle).toMatchObject({ env: { AGENTS_SMOKE_RUNNER_IMAGE: '${{ steps.smoke_runner.outputs.image }}' } })
    expect(lifecycle).not.toHaveProperty('if')
    expect(lifecycle?.run).toContain('${AGENTS_SMOKE_RUNNER_IMAGE:?')
    expect(workflow).not.toContain('crictl pull')
    const toolchain = step('Verify runner toolchain in a fresh Pod')
    expect(toolchain?.if).toContain("contains(fromJSON(needs.plan.outputs.image_targets), 'runner')")
    expect(toolchain?.run).toContain('BUILT_AGENTS_RUNNER_IMAGE_REPOSITORY')
    expect(toolchain?.run).toContain('agentrun-acceptance --smoke')
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

describe('Agents image publication', () => {
  it('publishes the slim runner from main without involving Kargo or gating its production receipt', () => {
    const { jobs } = parse(readWorkflow('agents-build-push.yml'))
    expect(jobs['smoke-runner-image']).toMatchObject({
      if: "github.ref == 'refs/heads/main'",
      uses: './.github/workflows/nix-oci-build-common.yml',
      with: {
        image_name: 'agents-smoke-runner',
        package_attr: 'agents-smoke-runner-image',
        tag: 'sha-${{ github.sha }}',
        publish_kargo_tag: false,
      },
    })
    expect(jobs['write-values'].needs).toEqual([
      'controller-image',
      'control-plane-image',
      'agents-shell-image',
      'runner-image',
    ])
    expect(JSON.stringify(jobs['write-values'])).not.toContain('agents-smoke-runner')
  })
})
