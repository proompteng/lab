#!/usr/bin/env bun

const LOCAL_IMAGE_PREFIXES = [
  'services/agents/',
  'packages/scripts/src/agents/deploy-service.ts',
  'packages/scripts/src/agents/smoke-agents.ts',
  'packages/otel/',
  'packages/agent-contracts/',
  'packages/temporal-bun-sdk/',
  'packages/codex/',
  'packages/cx-tools/',
]

const LOCAL_IMAGE_EXACT_PATHS = new Set([
  'bun.lock',
  'nix/images/agents.nix',
  'nix/images/bun-workspace-service.nix',
  'nix/images/openai-codex-cli.nix',
  'nix/packages.nix',
  'package.json',
  'packages/scripts/src/agents/deploy-service.ts',
  'packages/scripts/src/agents/smoke-agents.ts',
  'packages/scripts/src/shared/nix-oci-deploy.ts',
  'tsconfig.base.json',
])

const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx']

export type AgentsImageMode = 'build-local-image' | 'reuse-published-image'

export type AgentsImageModeResult = {
  mode: AgentsImageMode
  needsLocalAgentsImage: boolean
  matchedPaths: string[]
}

const normalizePath = (value: string) => value.trim().replace(/\\/g, '/')

const isDocumentationPath = (path: string) => {
  const lowerPath = path.toLowerCase()
  return DOCUMENTATION_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
}

const needsLocalImageForPath = (path: string) => {
  const normalized = normalizePath(path)
  if (!normalized) return false
  if (isDocumentationPath(normalized)) return false
  if (LOCAL_IMAGE_EXACT_PATHS.has(normalized)) return true
  return LOCAL_IMAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export const classifyAgentsImageMode = (paths: string[]): AgentsImageModeResult => {
  const normalizedPaths = paths.map((path) => normalizePath(path)).filter((path) => path.length > 0)
  const matchedPaths = normalizedPaths.filter((path) => needsLocalImageForPath(path))
  return {
    mode: matchedPaths.length > 0 ? 'build-local-image' : 'reuse-published-image',
    needsLocalAgentsImage: matchedPaths.length > 0,
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

const main = async () => {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const paths = args.length > 0 ? args : await readStdin()
  const result = classifyAgentsImageMode(paths)

  process.stdout.write(`NEEDS_LOCAL_AGENTS_IMAGE=${result.needsLocalAgentsImage}\n`)
  process.stdout.write(`AGENTS_IMAGE_MODE=${result.mode}\n`)
  process.stdout.write(`matched_paths=${result.matchedPaths.join(',')}\n`)
}

if (import.meta.main) {
  await main()
}
