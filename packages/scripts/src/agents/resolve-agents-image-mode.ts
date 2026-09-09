#!/usr/bin/env bun

import { appendFileSync } from 'node:fs'

export const AGENTS_IMAGE_TARGETS = ['control-plane', 'controller', 'runner', 'agents-shell'] as const

export type AgentsImageTarget = (typeof AGENTS_IMAGE_TARGETS)[number]
export type AgentsImageMode = 'build-local-image' | 'reuse-published-image'
export type AgentsCiTier = 'unit' | 'published-smoke' | 'local-smoke'

export type AgentsImageModeResult = {
  tier: AgentsCiTier
  mode: AgentsImageMode
  needsLocalAgentsImage: boolean
  runUnit: boolean
  runStatic: boolean
  runIntegration: boolean
  imageTargets: AgentsImageTarget[]
  matchedPaths: string[]
}

const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx']
const TEST_PATH_MARKERS = ['/__tests__/', '/tests/', '.test.', '.spec.', '/__snapshots__/']

const UNIT_PREFIXES = [
  'packages/agent-contracts/',
  'packages/codex/',
  'packages/cx-tools/',
  'packages/otel/',
  'packages/scripts/src/agents/',
  'packages/temporal-bun-sdk/',
  'services/agents/',
]

const STATIC_PREFIXES = [
  'argocd/applications/agents/',
  'argocd/applications/argo-workflows/',
  'charts/agents/',
  'scripts/agents/',
]

const STATIC_EXACT_PATHS = new Set([
  'packages/scripts/src/agents/deploy-service.ts',
  'packages/scripts/src/agents/smoke-agents.ts',
  'scripts/download_crd_schema.py',
])

const ALL_IMAGE_EXACT_PATHS = new Set([
  'services/agents/package.json',
  'flake.lock',
  'flake.nix',
  'nix/images/agents.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/packages.nix',
  'packages/scripts/src/shared/nix-oci-deploy.ts',
])

const RUNNER_IMAGE_EXACT_PATHS = new Set(['nix/images/openai-codex-cli.nix'])

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

const normalizePath = (value: string) => value.trim().replace(/\\/g, '/')

const isDocumentationPath = (path: string) => {
  const lowerPath = path.toLowerCase()
  return DOCUMENTATION_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
}

const isTestPath = (path: string) => TEST_PATH_MARKERS.some((marker) => path.includes(marker))

const isStaticPath = (path: string) =>
  STATIC_EXACT_PATHS.has(path) || STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))

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

export const classifyAgentsImageMode = (paths: string[]): AgentsImageModeResult => {
  const normalizedPaths = [...new Set(paths.map(normalizePath).filter(Boolean))].sort()
  const activePaths = normalizedPaths.filter((path) => !isDocumentationPath(path))
  const runStatic = activePaths.some(isStaticPath)
  const runUnit = activePaths.some(
    (path) =>
      path === '.github/workflows/agents-ci.yml' ||
      path === '.github/ci/impact-map.yml' ||
      UNIT_PREFIXES.some((prefix) => path.startsWith(prefix)),
  )
  const imageTargets = sortImageTargets(activePaths.flatMap(imageTargetsForPath))
  const matchedPaths = activePaths.filter((path) => imageTargetsForPath(path).length > 0)
  const needsLocalAgentsImage = imageTargets.length > 0
  const runIntegration = runStatic || needsLocalAgentsImage
  const tier: AgentsCiTier = needsLocalAgentsImage ? 'local-smoke' : runStatic ? 'published-smoke' : 'unit'

  return {
    tier,
    mode: needsLocalAgentsImage ? 'build-local-image' : 'reuse-published-image',
    needsLocalAgentsImage,
    runUnit,
    runStatic,
    runIntegration,
    imageTargets,
    matchedPaths,
  }
}

const readStdin = async () => {
  const data = await new Response(Bun.stdin.stream()).text()
  return data
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const readArg = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const outputLines = (result: AgentsImageModeResult) => [
  `tier=${result.tier}`,
  `run_unit=${result.runUnit}`,
  `run_static=${result.runStatic}`,
  `run_integration=${result.runIntegration}`,
  `NEEDS_LOCAL_AGENTS_IMAGE=${result.needsLocalAgentsImage}`,
  `AGENTS_IMAGE_MODE=${result.mode}`,
  `image_targets=${JSON.stringify(result.imageTargets)}`,
  `matched_paths=${JSON.stringify(result.matchedPaths)}`,
]

const main = async () => {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const githubOutput = readArg(args, '--github-output')
  const positionalArgs = args.filter((arg, index) => arg !== '--github-output' && args[index - 1] !== '--github-output')
  const paths = positionalArgs.length > 0 ? positionalArgs : await readStdin()
  const result = classifyAgentsImageMode(paths)
  const lines = outputLines(result)

  process.stdout.write(`${lines.join('\n')}\n`)
  if (githubOutput) appendFileSync(githubOutput, `${lines.join('\n')}\n`)
}

if (import.meta.main) {
  await main()
}

export const __private = {
  imageTargetsForPath,
  isStaticPath,
  isTestPath,
  outputLines,
}
