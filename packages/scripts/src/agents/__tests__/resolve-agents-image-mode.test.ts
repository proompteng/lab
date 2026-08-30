import { describe, expect, it } from 'bun:test'

import { classifyAgentsImageMode } from '../resolve-agents-image-mode'

describe('classifyAgentsImageMode', () => {
  it('keeps test-only changes on the Ubuntu unit tier', () => {
    expect(
      classifyAgentsImageMode([
        'services/agents/src/server/health.test.ts',
        'packages/scripts/src/agents/__tests__/smoke-agents.test.ts',
      ]),
    ).toEqual({
      tier: 'unit',
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      runUnit: true,
      runStatic: false,
      runIntegration: false,
      imageTargets: [],
      matchedPaths: [],
    })
  })

  it('uses published images for chart and smoke-harness changes', () => {
    expect(
      classifyAgentsImageMode([
        'charts/agents/templates/deployment.yaml',
        'packages/scripts/src/agents/smoke-agents.ts',
      ]),
    ).toEqual({
      tier: 'published-smoke',
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      runUnit: true,
      runStatic: true,
      runIntegration: true,
      imageTargets: [],
      matchedPaths: [],
    })
  })

  it('builds only the runner image for runner implementation changes', () => {
    const result = classifyAgentsImageMode(['services/agents/scripts/codex/agent-runner.ts'])

    expect(result.tier).toBe('local-smoke')
    expect(result.imageTargets).toEqual(['runner'])
    expect(result.matchedPaths).toEqual(['services/agents/scripts/codex/agent-runner.ts'])
  })

  it('rebuilds every image that embeds the shared Linear MCP bridge contract', () => {
    for (const path of [
      'services/agents/src/linear-mcp/bridge-auth.ts',
      'services/agents/src/linear-mcp/config.ts',
      'services/agents/src/linear-mcp/contract.ts',
    ]) {
      expect(classifyAgentsImageMode([path]).imageTargets).toEqual(['control-plane', 'controller', 'runner'])
    }
  })

  it('builds every image that embeds the Codex workspace package', () => {
    expect(classifyAgentsImageMode(['packages/codex/src/app-server.ts']).imageTargets).toEqual([
      'control-plane',
      'controller',
      'runner',
      'agents-shell',
    ])
  })

  it('builds the service pair for control-plane dependencies', () => {
    const result = classifyAgentsImageMode([
      'packages/agent-contracts/src/control-plane-status.ts',
      'packages/otel/src/api.ts',
      'packages/temporal-bun-sdk/src/index.ts',
    ])

    expect(result.imageTargets).toEqual(['control-plane', 'controller'])
    expect(result.needsLocalAgentsImage).toBe(true)
    expect(result.runIntegration).toBe(true)
  })

  it('builds the service pair for Agents server source changes', () => {
    const result = classifyAgentsImageMode(['services/agents/src/server/agents-controller/runtime-config.ts'])

    expect(result.imageTargets).toEqual(['control-plane', 'controller'])
    expect(result.tier).toBe('local-smoke')
  })

  it('builds all runtime images for the shared Agents package manifest', () => {
    expect(classifyAgentsImageMode(['services/agents/package.json']).imageTargets).toEqual([
      'control-plane',
      'controller',
      'runner',
      'agents-shell',
    ])
  })

  it('does not turn docs or Dockerfile-only changes into image builds', () => {
    const result = classifyAgentsImageMode([
      'services/agents/README.md',
      'packages/codex/docs/worker.mdx',
      'services/agents/Dockerfile',
    ])

    expect(result.tier).toBe('unit')
    expect(result.imageTargets).toEqual([])
    expect(result.runIntegration).toBe(false)
  })

  it('merges mixed image impact in stable component order', () => {
    const result = classifyAgentsImageMode([
      'services/agents/scripts/codex/agent-runner.ts',
      'services/agents/src/server/index.ts',
      'services/agents/src/server/index.ts',
    ])

    expect(result.imageTargets).toEqual(['control-plane', 'controller', 'runner'])
    expect(result.matchedPaths).toEqual([
      'services/agents/scripts/codex/agent-runner.ts',
      'services/agents/src/server/index.ts',
    ])
  })

  it('keeps shared JavaScript workspace inputs out of Agents runtime CI', () => {
    const result = classifyAgentsImageMode(['bun.lock', 'tsconfig.base.json'])

    expect(result).toMatchObject({
      tier: 'unit',
      runUnit: false,
      runStatic: false,
      runIntegration: false,
      imageTargets: [],
    })
  })

  it('builds all Agents images for shared Nix image inputs', () => {
    for (const path of [
      'flake.lock',
      'flake.nix',
      'nix/packages.nix',
      'packages/scripts/src/shared/nix-oci-deploy.ts',
    ]) {
      const result = classifyAgentsImageMode([path])
      expect(result).toMatchObject({
        tier: 'local-smoke',
        mode: 'build-local-image',
        needsLocalAgentsImage: true,
        runIntegration: true,
        imageTargets: ['control-plane', 'controller', 'runner', 'agents-shell'],
        matchedPaths: [path],
      })
    }
  })
})
