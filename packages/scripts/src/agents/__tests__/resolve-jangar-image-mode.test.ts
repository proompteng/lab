import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

import { classifyJangarImageMode } from '../resolve-jangar-image-mode'

describe('classifyJangarImageMode', () => {
  it('reuses the published image for chart-only changes', () => {
    expect(
      classifyJangarImageMode(['scripts/agents/values-ci.yaml', 'charts/agents/templates/deployment.yaml']),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalJangarImage: false,
      matchedPaths: [],
    })
  })

  it('reuses the published image for smoke-harness and agents-ci workflow changes', () => {
    expect(
      classifyJangarImageMode([
        '.github/workflows/agents-ci.yml',
        'packages/scripts/src/agents/resolve-jangar-image-mode.ts',
        'packages/scripts/src/agents/__tests__/resolve-jangar-image-mode.test.ts',
        'scripts/agents/values-ci.yaml',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalJangarImage: false,
      matchedPaths: [],
    })
  })

  it('reuses the published image for jangar build workflow-only changes', () => {
    expect(
      classifyJangarImageMode([
        '.github/workflows/jangar-build-push.yaml',
        '.github/workflows/jangar-release.yml',
        '.github/workflows/jangar-post-deploy-verify.yml',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalJangarImage: false,
      matchedPaths: [],
    })
  })

  it('builds a local image for jangar changes', () => {
    const result = classifyJangarImageMode(['services/jangar/src/server/control-plane-status.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.needsLocalJangarImage).toBe(true)
    expect(result.matchedPaths).toEqual(['services/jangar/src/server/control-plane-status.ts'])
  })

  it('builds a local image when bun.lock changes', () => {
    const result = classifyJangarImageMode(['bun.lock'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['bun.lock'])
  })

  it('builds a local image for shared jangar dependency package changes', () => {
    const result = classifyJangarImageMode(['packages/temporal-bun-sdk/src/index.ts'])
    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/temporal-bun-sdk/src/index.ts'])
  })

  it('reuses the published image for documentation-only changes under local image prefixes', () => {
    expect(
      classifyJangarImageMode([
        'services/jangar/README.md',
        'packages/temporal-bun-sdk/CHANGELOG.md',
        'packages/codex/docs/worker.mdx',
      ]),
    ).toEqual({
      mode: 'reuse-published-image',
      needsLocalJangarImage: false,
      matchedPaths: [],
    })
  })

  it('ignores documentation paths while still matching source changes', () => {
    const result = classifyJangarImageMode([
      'packages/temporal-bun-sdk/CHANGELOG.md',
      'packages/temporal-bun-sdk/src/index.ts',
    ])

    expect(result.mode).toBe('build-local-image')
    expect(result.matchedPaths).toEqual(['packages/temporal-bun-sdk/src/index.ts'])
  })
})

describe('agents-ci workflow local Jangar image build', () => {
  it('uses the mirrored Bun base image for local CI rebuilds', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('--build-arg "BUN_BASE_IMAGE=mirror.gcr.io/oven/bun" \\')
    expect(workflow).not.toContain('BUN_BASE_IMAGE=docker.io/oven/bun')
  })

  it('classifies pull request changes from the merge base', () => {
    const workflow = readFileSync(new URL('../../../../../.github/workflows/agents-ci.yml', import.meta.url), 'utf8')

    expect(workflow).toContain('git diff --name-only "${BASE_SHA}...${HEAD_SHA}"')
  })
})
