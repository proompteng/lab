import { describe, expect, it } from 'bun:test'

import { classifyAgentsImageMode } from '../resolve-agents-image-mode'

const classifyPullRequest = (paths: string[]) => classifyAgentsImageMode(paths, 'pull_request')

describe('classifyAgentsImageMode', () => {
  it('requires Kind without rebuilding images for service test changes', () => {
    expect(
      classifyPullRequest([
        'services/agents/src/server/health.test.ts',
        'packages/scripts/src/agents/__tests__/smoke-agents.test.ts',
      ]),
    ).toEqual({
      tier: 'published-smoke',
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      runUnit: true,
      runStatic: true,
      runIntegration: true,
      imageTargets: [],
      verifyDependencyClosure: false,
      matchedPaths: [],
    })
  })

  it('uses published images for chart and smoke-harness changes', () => {
    expect(
      classifyPullRequest(['charts/agents/templates/deployment.yaml', 'packages/scripts/src/agents/smoke-agents.ts']),
    ).toEqual({
      tier: 'published-smoke',
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      runUnit: true,
      runStatic: true,
      runIntegration: true,
      imageTargets: [],
      verifyDependencyClosure: false,
      matchedPaths: [],
    })
  })

  it('runs the published smoke tier when its workflow changes', () => {
    expect(classifyPullRequest(['.github/workflows/agents-ci.yml'])).toEqual({
      tier: 'published-smoke',
      mode: 'reuse-published-image',
      needsLocalAgentsImage: false,
      runUnit: true,
      runStatic: true,
      runIntegration: true,
      imageTargets: [],
      verifyDependencyClosure: false,
      matchedPaths: [],
    })
  })

  it.each(['scripts/agents/validate-agents.sh', 'scripts/download_crd_schema.py'])(
    'runs only chart and CRD checks on a verifier-only push to %s',
    (path) => {
      expect(classifyAgentsImageMode([path], 'push')).toMatchObject({
        tier: 'static',
        runUnit: false,
        runStatic: true,
        runIntegration: false,
        imageTargets: [],
      })
      expect(classifyAgentsImageMode([path, 'scripts/agents/values-ci.yaml'], 'push')).toMatchObject({
        tier: 'published-smoke',
        runStatic: true,
        runIntegration: true,
      })
    },
  )

  it('never selects the fast tier for a direct push or a merge group', () => {
    const files = ['docs/agents/runbooks.md', 'packages/scripts/src/agents/curate-ontology-deltas.ts']
    for (const event of ['push', 'merge_group', 'workflow_dispatch']) {
      expect(classifyAgentsImageMode(files, event).tier).not.toBe('fast')
    }
  })

  it('builds only the runner image for runner implementation changes', () => {
    const result = classifyPullRequest(['services/agents/scripts/codex/agent-runner.ts'])

    expect(result.tier).toBe('local-smoke')
    expect(result.imageTargets).toEqual(['runner'])
    expect(result.matchedPaths).toEqual(['services/agents/scripts/codex/agent-runner.ts'])
  })

  it('rebuilds the runner when its toolchain or acceptance command changes', () => {
    for (const path of ['nix/images/agentrun-tools.nix', 'services/agents/scripts/runner-acceptance.sh']) {
      expect(classifyPullRequest([path]).imageTargets).toEqual(['runner'])
    }
  })

  it('rebuilds every image that embeds the shared Linear MCP bridge contract', () => {
    for (const path of [
      'services/agents/src/linear-mcp/bridge-auth.ts',
      'services/agents/src/linear-mcp/config.ts',
      'services/agents/src/linear-mcp/contract.ts',
    ]) {
      expect(classifyPullRequest([path]).imageTargets).toEqual(['control-plane', 'controller', 'runner'])
    }
  })

  it('builds every image that embeds the Codex workspace package', () => {
    expect(classifyPullRequest(['packages/codex/src/app-server.ts']).imageTargets).toEqual([
      'control-plane',
      'controller',
      'runner',
      'agents-shell',
    ])
  })

  it('rebuilds all images that embed the shared patch helper', () => {
    expect(classifyPullRequest(['services/agents/scripts/apply_patch.py']).imageTargets).toEqual([
      'control-plane',
      'controller',
      'runner',
      'agents-shell',
    ])
  })

  it('builds the service pair for control-plane dependencies', () => {
    const result = classifyPullRequest([
      'packages/agent-contracts/src/control-plane-status.ts',
      'packages/otel/src/api.ts',
      'packages/temporal-bun-sdk/src/index.ts',
    ])

    expect(result.imageTargets).toEqual(['control-plane', 'controller'])
    expect(result.needsLocalAgentsImage).toBe(true)
    expect(result.runIntegration).toBe(true)
  })

  it('builds the service pair for Agents server source changes', () => {
    const result = classifyPullRequest(['services/agents/src/server/agents-controller/runtime-config.ts'])

    expect(result.imageTargets).toEqual(['control-plane', 'controller'])
    expect(result.tier).toBe('local-smoke')
  })

  it('builds all runtime images for the shared Agents package manifest', () => {
    expect(classifyPullRequest(['services/agents/package.json']).imageTargets).toEqual([
      'control-plane',
      'controller',
      'runner',
      'agents-shell',
    ])
  })

  it('does not turn docs or Dockerfile-only changes into image builds', () => {
    const result = classifyPullRequest([
      'services/agents/README.md',
      'packages/codex/docs/worker.mdx',
      'services/agents/Dockerfile',
    ])

    expect(result.tier).toBe('published-smoke')
    expect(result.imageTargets).toEqual([])
    expect(result.runIntegration).toBe(true)
  })

  it('merges mixed image impact in stable component order', () => {
    const result = classifyPullRequest([
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

  it('verifies the installed Effect patch without coupling builds to unrelated patches', () => {
    const installed = classifyPullRequest(['patches/effect@4.1.4.patch'])
    expect(installed.tier).toBe('local-smoke')
    expect(installed.imageTargets).toEqual(['control-plane', 'controller', 'runner', 'agents-shell'])
    expect(installed.verifyDependencyClosure).toBe(true)
    for (const path of ['patches/@effect%2Fsql-pg@4.1.4.patch', 'patches/@platformatic%2Fkafka@2.12.1.patch']) {
      const result = classifyAgentsImageMode([path], 'push')
      expect(result.runIntegration).toBe(false)
      expect(result.verifyDependencyClosure).toBe(false)
    }
  })

  it('checks cold dependency output only for selected dependency inputs', () => {
    for (const path of [
      'nix/images/agents.nix',
      'nix/images/bun-workspace-service.nix',
      'nix/images/relativize-bun-cache.sh',
      'nix/packages.nix',
      'flake.lock',
      'flake.nix',
      'services/agents/package.json',
      'packages/codex/package.json',
      'packages/otel/package.json',
    ]) {
      const result = classifyPullRequest([path])
      expect(result.verifyDependencyClosure).toBe(true)
      expect(result.needsLocalAgentsImage).toBe(true)
    }
    for (const path of [
      'services/agents/src/server/health.ts',
      'services/agents/src/server/health.test.ts',
      'services/agents/README.md',
      'charts/agents/templates/deployment.yaml',
      'package.json',
      'bun.lock',
    ]) {
      expect(classifyPullRequest([path]).verifyDependencyClosure).toBe(false)
    }
  })

  it('keeps shared JavaScript workspace inputs out of Agents runtime CI', () => {
    const result = classifyAgentsImageMode(['bun.lock', 'tsconfig.base.json'], 'push')

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
      const result = classifyPullRequest([path])
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
