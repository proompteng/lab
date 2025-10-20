import { posix } from 'node:path'

export interface ZigTarget {
  triple: string
  platform: 'darwin' | 'linux'
  arch: 'arm64' | 'x64'
  extension: 'dylib' | 'so'
  cargoTarget: 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'aarch64-unknown-linux-gnu' | 'x86_64-unknown-linux-gnu'
}

export const zigTargets: ZigTarget[] = [
  {
    triple: 'aarch64-macos',
    platform: 'darwin',
    arch: 'arm64',
    extension: 'dylib',
    cargoTarget: 'aarch64-apple-darwin',
  },
  {
    triple: 'x86_64-macos',
    platform: 'darwin',
    arch: 'x64',
    extension: 'dylib',
    cargoTarget: 'x86_64-apple-darwin',
  },
  {
    triple: 'aarch64-linux-gnu',
    platform: 'linux',
    arch: 'arm64',
    extension: 'so',
    cargoTarget: 'aarch64-unknown-linux-gnu',
  },
  {
    triple: 'x86_64-linux-gnu',
    platform: 'linux',
    arch: 'x64',
    extension: 'so',
    cargoTarget: 'x86_64-unknown-linux-gnu',
  },
]

export const artifactFilename = (target: ZigTarget): string => `libtemporal_bun_bridge_zig.${target.extension}`

export const relativeArtifactSubpath = (target: ZigTarget): string =>
  posix.join(target.platform, target.arch, artifactFilename(target))
