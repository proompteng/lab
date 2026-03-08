#!/usr/bin/env bun

const LOCAL_IMAGE_PREFIXES = [
  'services/jangar/',
  'packages/otel/',
  'packages/temporal-bun-sdk/',
  'packages/codex/',
  'packages/design/',
  'packages/bumba/',
  'packages/discord/',
  'packages/cx-tools/',
  'services/bumba/',
]

const LOCAL_IMAGE_EXACT_PATHS = new Set([
  'bun.lock',
  'package.json',
  '.github/workflows/jangar-build-push.yaml',
  'packages/scripts/src/jangar/build-control-plane-image.ts',
  'packages/scripts/src/jangar/build-image.ts',
  'packages/scripts/src/shared/docker.ts',
  'tsconfig.base.json',
])

export type JangarImageMode = 'build-local-image' | 'reuse-published-image'

export type JangarImageModeResult = {
  mode: JangarImageMode
  needsLocalJangarImage: boolean
  matchedPaths: string[]
}

const normalizePath = (value: string) => value.trim().replace(/\\/g, '/')

const needsLocalImageForPath = (path: string) => {
  const normalized = normalizePath(path)
  if (!normalized) return false
  if (LOCAL_IMAGE_EXACT_PATHS.has(normalized)) return true
  return LOCAL_IMAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

export const classifyJangarImageMode = (paths: string[]): JangarImageModeResult => {
  const normalizedPaths = paths.map((path) => normalizePath(path)).filter((path) => path.length > 0)
  const matchedPaths = normalizedPaths.filter((path) => needsLocalImageForPath(path))
  return {
    mode: matchedPaths.length > 0 ? 'build-local-image' : 'reuse-published-image',
    needsLocalJangarImage: matchedPaths.length > 0,
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
  const result = classifyJangarImageMode(paths)

  process.stdout.write(`NEEDS_LOCAL_JANGAR_IMAGE=${result.needsLocalJangarImage}\n`)
  process.stdout.write(`JANGAR_IMAGE_MODE=${result.mode}\n`)
  process.stdout.write(`matched_paths=${result.matchedPaths.join(',')}\n`)
}

if (import.meta.main) {
  await main()
}
