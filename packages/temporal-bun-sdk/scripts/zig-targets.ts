import { posix } from 'node:path'
import process from 'node:process'

export interface ZigTarget {
  triple: string
  platform: 'darwin' | 'linux'
  arch: 'arm64' | 'x64'
  extension: 'dylib' | 'so'
}

const allZigTargets: ZigTarget[] = [
  { triple: 'aarch64-macos', platform: 'darwin', arch: 'arm64', extension: 'dylib' },
  { triple: 'aarch64-linux-gnu', platform: 'linux', arch: 'arm64', extension: 'so' },
  { triple: 'x86_64-linux-gnu', platform: 'linux', arch: 'x64', extension: 'so' },
]

const aliasMap: Record<string, Array<ZigTarget['triple']>> = {
  darwin: ['aarch64-macos'],
  macos: ['aarch64-macos'],
  linux: ['aarch64-linux-gnu', 'x86_64-linux-gnu'],
  'linux-arm64': ['aarch64-linux-gnu'],
  'linux-x64': ['x86_64-linux-gnu'],
}

const zigTargetIndex = new Map<string, ZigTarget>()
for (const target of allZigTargets) {
  zigTargetIndex.set(target.triple, target)
  zigTargetIndex.set(`${target.platform}-${target.arch}`, target)
  zigTargetIndex.set(`${target.platform}/${target.arch}`, target)
}

const resolveZigTargets = (): ZigTarget[] => {
  const raw = process.env.TEMPORAL_BUN_SDK_TARGETS?.trim()
  if (!raw) {
    return allZigTargets
  }

  const result: ZigTarget[] = []
  const seen = new Set<string>()
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return allZigTargets
  }

  const addTriple = (triple: ZigTarget['triple']) => {
    if (seen.has(triple)) return
    const target = zigTargetIndex.get(triple)
    if (!target) {
      throw new Error(`Unknown Zig target '${triple}' derived from TEMPORAL_BUN_SDK_TARGETS=${raw}`)
    }
    seen.add(triple)
    result.push(target)
  }

  for (const token of tokens) {
    const aliasTargets = aliasMap[token]
    if (aliasTargets) {
      for (const triple of aliasTargets) {
        addTriple(triple)
      }
      continue
    }
    const target = zigTargetIndex.get(token)
    if (!target) {
      throw new Error(`Unknown Zig target '${token}' in TEMPORAL_BUN_SDK_TARGETS`)
    }
    addTriple(target.triple)
  }

  if (result.length === 0) {
    throw new Error(`TEMPORAL_BUN_SDK_TARGETS=${raw} did not resolve to any Zig targets`)
  }

  return result
}

export const zigTargets = resolveZigTargets()

export const artifactFilename = (target: ZigTarget): string => `libtemporal_bun_bridge_zig.${target.extension}`

export const relativeArtifactSubpath = (target: ZigTarget): string =>
  posix.join(target.platform, target.arch, artifactFilename(target))
