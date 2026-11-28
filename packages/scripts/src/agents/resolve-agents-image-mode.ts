#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'

export const AGENTS_IMAGE_TARGETS = ['control-plane', 'controller', 'runner', 'agents-shell'] as const

export type AgentsImageTarget = (typeof AGENTS_IMAGE_TARGETS)[number]
export type AgentsImageMode = 'build-local-image' | 'reuse-published-image'
export type AgentsCiTier = 'fast' | 'unit' | 'static' | 'published-smoke' | 'local-smoke'

export type AgentsImageModeResult = {
  tier: AgentsCiTier
  mode: AgentsImageMode
  needsLocalAgentsImage: boolean
  runUnit: boolean
  runStatic: boolean
  runIntegration: boolean
  imageTargets: AgentsImageTarget[]
  verifyDependencyClosure: boolean
  matchedPaths: string[]
}

const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx']
const TEST_PATH_MARKERS = ['/__tests__/', '/tests/', '.test.', '.spec.', '/__snapshots__/']
const AGENTS_SCRIPT_DIR = 'packages/scripts/src/agents'

// Only these tools are exercised without a cluster or live service. New tools
// and the Kind harness must not become fast-tier inputs by directory alone.
const OFFLINE_SCRIPT_PATHS = new Set(
  [
    'agents-ontology-schema',
    'curate-ontology-deltas',
    'ontology-bundle-sql',
    'ontology-deltas',
    'ontology-migration-relations',
    'ontology-sql',
    'sync-auto-ontology-bundle-core',
    'sync-auto-ontology-bundle',
    'validate-ontology-bundles',
  ].flatMap((name) => [`${AGENTS_SCRIPT_DIR}/${name}.ts`, `${AGENTS_SCRIPT_DIR}/__tests__/${name}.test.ts`]),
)

const UNIT_PREFIXES = [
  'packages/agent-contracts/',
  'packages/codex/',
  'packages/cx-tools/',
  'packages/otel/',
  `${AGENTS_SCRIPT_DIR}/`,
  'packages/temporal-bun-sdk/',
  'services/agents/',
]

const PUBLISHED_SMOKE_PREFIXES = [
  'argocd/applications/agents/',
  'argocd/applications/argo-workflows/',
  'charts/agents/',
  'nix/images/',
  'scripts/agents/',
  'services/agents/',
]

const PUBLISHED_SMOKE_EXACT_PATHS = new Set([
  '.github/workflows/agents-ci.yml',
  `${AGENTS_SCRIPT_DIR}/collect-smoke-diagnostics.ts`,
  `${AGENTS_SCRIPT_DIR}/deploy-service.ts`,
  `${AGENTS_SCRIPT_DIR}/resolve-agents-image-mode.ts`,
  `${AGENTS_SCRIPT_DIR}/resolve-published-agents-images.ts`,
  `${AGENTS_SCRIPT_DIR}/smoke-agents.ts`,
])

const STATIC_ONLY_PATHS = new Set(['scripts/agents/validate-agents.sh', 'scripts/download_crd_schema.py'])

const DEPENDENCY_EXACT_PATHS = new Set([
  'patches/effect@4.1.4.patch',
  'flake.lock',
  'flake.nix',
  'nix/packages.nix',
  'nix/images/agents.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/relativize-bun-cache.sh',
  'services/agents/package.json',
  'packages/agent-contracts/package.json',
  'packages/codex/package.json',
  'packages/cx-tools/package.json',
  'packages/otel/package.json',
  'packages/temporal-bun-sdk/package.json',
])

const ALL_IMAGE_EXACT_PATHS = new Set([
  'patches/effect@4.1.4.patch',
  'services/agents/package.json',
  'services/agents/scripts/apply_patch.py',
  'flake.lock',
  'flake.nix',
  'nix/images/agents.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/relativize-bun-cache.sh',
  'nix/packages.nix',
  'packages/scripts/src/shared/nix-oci-deploy.ts',
])

const RUNNER_IMAGE_EXACT_PATHS = new Set([
  'nix/images/openai-codex-cli.nix',
  'nix/images/agentrun-tools.nix',
  'services/agents/scripts/runner-acceptance.sh',
])

const CONTROL_PLANE_IMAGE_PREFIXES = [
  'packages/agent-contracts/',
  'packages/cx-tools/',
  'packages/otel/',
  'packages/temporal-bun-sdk/',
]

const LINEAR_MCP_RUNNER_SHARED_PATHS = new Set([
  'services/agents/src/linear-mcp/bridge-auth.ts',
  'services/agents/src/linear-mcp/config.ts',
  'services/agents/src/linear-mcp/contract.ts',
])

const isFastPath = (path: string) => path.startsWith('docs/agents/') || OFFLINE_SCRIPT_PATHS.has(path)

const isDocumentationPath = (path: string) => {
  const lowerPath = path.toLowerCase()
  return DOCUMENTATION_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
}

const isTestPath = (path: string) => TEST_PATH_MARKERS.some((marker) => path.includes(marker))

const isPublishedSmokePath = (path: string) =>
  !STATIC_ONLY_PATHS.has(path) &&
  (PUBLISHED_SMOKE_EXACT_PATHS.has(path) || PUBLISHED_SMOKE_PREFIXES.some((prefix) => path.startsWith(prefix)))

const imageTargetsForPath = (path: string): AgentsImageTarget[] => {
  if (isDocumentationPath(path) || isTestPath(path)) return []
  if (ALL_IMAGE_EXACT_PATHS.has(path)) return [...AGENTS_IMAGE_TARGETS]
  if (RUNNER_IMAGE_EXACT_PATHS.has(path)) return ['runner']
  if (path.startsWith('packages/codex/')) return [...AGENTS_IMAGE_TARGETS]
  if (LINEAR_MCP_RUNNER_SHARED_PATHS.has(path)) return ['control-plane', 'controller', 'runner']
  if (path.startsWith('services/agents/src/runner/') || path.startsWith('services/agents/scripts/codex/')) {
    return ['runner']
  }
  if (CONTROL_PLANE_IMAGE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return ['control-plane', 'controller']
  }
  if (path.startsWith('services/agents/')) {
    if (path.startsWith('services/agents/agentctl/') || path.startsWith('services/agents/Dockerfile')) return []
    return ['control-plane', 'controller']
  }
  return []
}

const sortImageTargets = (targets: Iterable<AgentsImageTarget>): AgentsImageTarget[] => {
  const selected = new Set(targets)
  return AGENTS_IMAGE_TARGETS.filter((target) => selected.has(target))
}

export const classifyAgentsImageMode = (paths: string[], event: string): AgentsImageModeResult => {
  const pullRequest = event === 'pull_request'
  const fast = pullRequest && paths.length > 0 && paths.every(isFastPath)
  const activePaths = [...new Set(paths)].filter((path) => !isDocumentationPath(path)).sort()
  const runPublishedSmoke = !fast && (pullRequest || paths.some(isPublishedSmokePath))
  const runStatic = runPublishedSmoke || activePaths.some((path) => STATIC_ONLY_PATHS.has(path))
  const runUnit =
    !fast &&
    activePaths.some(
      (path) =>
        path === '.github/workflows/agents-ci.yml' ||
        path === '.github/ci/impact-map.yml' ||
        UNIT_PREFIXES.some((prefix) => path.startsWith(prefix)),
    )
  const imageTargets = sortImageTargets(activePaths.flatMap(imageTargetsForPath))
  const matchedPaths = activePaths.filter((path) => imageTargetsForPath(path).length > 0)
  const needsLocalAgentsImage = imageTargets.length > 0
  const runIntegration = runPublishedSmoke || needsLocalAgentsImage
  const tier: AgentsCiTier = fast
    ? 'fast'
    : needsLocalAgentsImage
      ? 'local-smoke'
      : runPublishedSmoke
        ? 'published-smoke'
        : runStatic
          ? 'static'
          : 'unit'

  return {
    tier,
    mode: needsLocalAgentsImage ? 'build-local-image' : 'reuse-published-image',
    needsLocalAgentsImage,
    runUnit,
    runStatic,
    runIntegration,
    imageTargets,
    verifyDependencyClosure: activePaths.some((path) => DEPENDENCY_EXACT_PATHS.has(path)),
    matchedPaths,
  }
}

const isRepoPath = (path: unknown): path is string => {
  return (
    typeof path === 'string' &&
    !path.includes('\0') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

const outputLines = (result: AgentsImageModeResult) => [
  `tier=${result.tier}`,
  `run_unit=${result.runUnit}`,
  `run_static=${result.runStatic}`,
  `run_integration=${result.runIntegration}`,
  `NEEDS_LOCAL_AGENTS_IMAGE=${result.needsLocalAgentsImage}`,
  `AGENTS_IMAGE_MODE=${result.mode}`,
  `image_targets=${JSON.stringify(result.imageTargets)}`,
  `verify_dependency_closure=${result.verifyDependencyClosure}`,
  `matched_paths=${JSON.stringify(result.matchedPaths)}`,
]

const main = async () => {
  const event = process.env.GITHUB_EVENT_NAME ?? ''
  const githubOutput = process.env.GITHUB_OUTPUT
  if (!['pull_request', 'push', 'merge_group', 'workflow_dispatch'].includes(event)) {
    throw new Error('Expected a supported Agents CI event')
  }
  // Parse and validate before any job selection; an incomplete PR diff cannot opt out of smoke.
  const paths: unknown = JSON.parse(await new Response(Bun.stdin.stream()).text())
  if (!Array.isArray(paths) || !paths.every(isRepoPath) || (event === 'pull_request' && paths.length === 0)) {
    throw new Error('Expected a changed-file array with repository-relative paths and a nonempty PR diff')
  }
  const result = classifyAgentsImageMode(paths, event)
  const lines = outputLines(result)

  process.stdout.write(`${lines.join('\n')}\n`)
  if (githubOutput) appendFileSync(githubOutput, `${lines.join('\n')}\n`)
}

if (import.meta.main) await main()
