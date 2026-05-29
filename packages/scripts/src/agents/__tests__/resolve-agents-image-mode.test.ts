import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

import { classifyAgentsImageMode } from '../resolve-agents-image-mode'

describe('classifyAgentsImageMode', () => {
  it('reuses the published image for chart-only changes', () => {
    expect(
      classifyAgentsImageMode(['scripts/agents/values-ci.yaml', 'charts/agents/templates/deployment.yaml']),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      matchedPaths: [],
    })
  })

  it('builds a local image for smoke harness changes', () => {
    expect(
      classifyAgentsImageMode([
        'packages/scripts/src/agents/smoke-agents.ts',
        'packages/scripts/src/agents/__tests__/smoke-agents.test.ts',
      ]),
    ).toEqual({
      mode: 'build-local-image',
      needsLocalAgentsImage: true,
      matchedPaths: ['packages/scripts/src/agents/smoke-agents.ts'],
    })
  })

  it('reuses the published image for agents-ci workflow-only changes', () => {
    expect(classifyAgentsImageMode(['.github/workflows/agents-ci.yml', 'scripts/agents/values-ci.yaml'])).toEqual({
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      matchedPaths: [],
    })
  })

  it('reuses the published image for image classifier-only changes', () => {
    expect(
      classifyAgentsImageMode([
        'packages/scripts/src/agents/resolve-agents-image-mode.ts',
        'packages/scripts/src/agents/__tests__/resolve-agents-image-mode.test.ts',
        'scripts/agents/values-ci.yaml',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      matchedPaths: [],
    })
  })

  it('reuses the published image for Jangar build workflow-only changes', () => {
    expect(
      classifyAgentsImageMode([
        '.github/workflows/jangar-build-push.yaml',
        '.github/workflows/jangar-release.yml',
        '.github/workflows/jangar-post-deploy-verify.yml',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      matchedPaths: [],
    })
  })

  it('builds a local image for Agents service changes', () => {
    const result = classifyAgentsImageMode(['services/agents/src/server/agents-controller/runtime-config.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.needsLocalAgentsImage).toBe(true)
    expect(result.matchedPaths).toEqual(['services/agents/src/server/agents-controller/runtime-config.ts'])
  })

  it('reuses the published Agents image for Jangar-only runtime changes', () => {
    const result = classifyAgentsImageMode(['services/jangar/src/server/control-plane-status.ts'])
    expect(result.mode).toBe('reuse-published-image')
    expect(result.needsLocalAgentsImage).toBe(false)
    expect(result.matchedPaths).toEqual([])
  })

  it('builds a local image when bun.lock changes', () => {
    const result = classifyAgentsImageMode(['bun.lock'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['bun.lock'])
  })

  it('builds a local image for shared Agents runtime dependency package changes', () => {
    const result = classifyAgentsImageMode(['packages/temporal-bun-sdk/src/index.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/temporal-bun-sdk/src/index.ts'])
  })

  it('builds a local image for Agents public contract changes', () => {
    const result = classifyAgentsImageMode(['packages/agent-contracts/src/control-plane-status.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/agent-contracts/src/control-plane-status.ts'])
  })

  it('reuses the published image for documentation-only changes under local image prefixes', () => {
    expect(
      classifyAgentsImageMode([
        'services/agents/README.md',
        'services/jangar/README.md',
        'packages/temporal-bun-sdk/CHANGELOG.md',
        'packages/codex/docs/worker.mdx',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      matchedPaths: [],
    })
  })

  it('ignores documentation paths while still matching source changes', () => {
    const result = classifyAgentsImageMode([
      'packages/temporal-bun-sdk/CHANGELOG.md',
      'packages/temporal-bun-sdk/src/index.ts',
    ])

    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/temporal-bun-sdk/src/index.ts'])
  })
})

describe('agents-ci workflow local Agents image build', () => {
  it('uses the mirrored Bun base image for local CI rebuilds', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('--build-arg "BUN_BASE_IMAGE=mirror.gcr.io/oven/bun" \\')
    expect(workflow).not.toContain('BUN_BASE_IMAGE=docker.io/oven/bun')
  })

  it('classifies pull request changes from the merge base', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('git diff --name-only "${BASE_SHA}...${HEAD_SHA}"')
  })

  it('installs kubectl without sudo so ARC runners cannot hang on password prompts', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('install_dir="${RUNNER_TEMP:-/tmp}/agents-ci-bin"')
    expect(workflow).toContain('echo "${install_dir}" >> "${GITHUB_PATH}"')
    expect(workflow).not.toContain('sudo mv kubectl')
  })

  it('resolves published smoke images from Agents GitOps values instead of Jangar release contracts', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('resolve-published-agents-images.ts')
    expect(workflow).toContain('--values-path argocd/applications/agents/values.yaml')
    expect(workflow).toContain('AGENTS_CONTROL_PLANE_IMAGE_REPOSITORY')
    expect(workflow).toContain('AGENTS_CONTROLLER_IMAGE_REPOSITORY')
    expect(workflow).toContain('AGENTS_RUNNER_IMAGE_REPOSITORY')
    expect(workflow).not.toContain('resolve-published-jangar-image.ts')
    expect(workflow).not.toContain('jangar-release-contract')
  })

  it('keeps Agents CI detached from Jangar service and GitOps paths', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).not.toContain('services/jangar/**')
    expect(workflow).not.toContain('argocd/applications/jangar/**')
    expect(workflow).not.toContain('docs/jangar/application-architecture.md')
    expect(workflow).not.toContain('packages/scripts/src/jangar/**')
    expect(workflow).not.toContain('packages/scripts/src/jangar/verify-deployment.ts')
    expect(workflow).not.toContain('--filter @proompteng/jangar')
    expect(workflow).not.toContain('packages/scripts/src/jangar/__tests__/release-contract.test.ts')
  })

  it('keeps Agents image publication detached from Jangar-only source changes', () => {
    const workflow = readFileSync(
      new URL('../../../../../.github/workflows/agents-build-push.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).not.toContain("      - 'services/jangar/**'")
    expect(workflow).toContain('services/agents/**')
    expect(workflow).toContain('group: agents-build-${{ github.ref }}')
    expect(workflow).not.toContain('group: agents-build-${{ github.ref }}-${{ github.sha }}')
  })

  it('builds local Agents smoke images from the Agents Dockerfile', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('-f "${WORKSPACE}/services/agents/Dockerfile"')
    expect(workflow).toContain('-f "${WORKSPACE}/services/agents/Dockerfile.codex-runner"')
    expect(workflow).toContain('--scope=@proompteng/agent-contracts')
    expect(workflow).toContain('--scope=@proompteng/codex')
    expect(workflow).toContain('cp -R "${PRUNE_DIR}/full/services/agents" "${PRUNE_DIR}/services/agents"')
    expect(workflow).toContain('cp -R "${PRUNE_DIR}/full/packages/codex" "${PRUNE_DIR}/packages/codex"')
    expect(workflow).toContain('packages/agent-contracts/**')
    expect(workflow).toContain('--target control-plane')
    expect(workflow).toContain('--target controller')
    expect(workflow).toContain('BUILT_AGENTS_CONTROLLER_IMAGE_REPOSITORY')
    expect(workflow).toContain('BUILT_AGENTS_RUNNER_IMAGE_REPOSITORY')
    expect(workflow).toContain('agents-runner-image-smoke')
    expect(workflow).toContain('--build-arg "AGENTS_VERSION=${AGENTS_VERSION}"')
    expect(workflow).not.toContain('-f "${WORKSPACE}/services/jangar/Dockerfile"')
    expect(workflow).not.toContain('--build-arg "JANGAR_VERSION=')
  })
})

describe('agents-release workflow', () => {
  it('can manually promote a specific Agents build artifact by run id and source SHA', () => {
    const workflow = readFileSync(
      new URL('../../../../../.github/workflows/agents-release.yml', import.meta.url),
      'utf8',
    )

    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('run_id:')
    expect(workflow).toContain('source_sha:')
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'")
    expect(workflow).toContain('run-id: ${{ steps.meta.outputs.run_id }}')
    expect(workflow).toContain('Promotion source: `${{ steps.meta.outputs.promotion_source }}`')
  })
})
