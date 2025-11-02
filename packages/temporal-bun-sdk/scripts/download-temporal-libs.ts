#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const OWNER = 'proompteng'
const REPO = 'lab'
const DEFAULT_TAG = process.env.TEMPORAL_LIBS_VERSION ?? 'temporal-libs-v1.0.2'
export const CACHE_ROOT = '.temporal-libs-cache'

export const SUPPORTED_PLATFORMS = ['linux-arm64', 'linux-x64', 'macos-arm64'] as const

export type PlatformTriple = (typeof SUPPORTED_PLATFORMS)[number]

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface ReleaseResponse {
  tag_name: string
  assets: ReleaseAsset[]
}

export function detectPlatform(): PlatformTriple {
  const platform = process.env.FORCE_PLATFORM ?? process.platform
  const arch = process.env.FORCE_ARCH ?? process.arch

  if (platform === 'linux') {
    if (arch === 'arm64') return 'linux-arm64'
    if (arch === 'x64') return 'linux-x64'
  }

  if (platform === 'darwin') {
    if (arch === 'arm64') return 'macos-arm64'
  }

  throw new Error(`Unsupported platform combination: platform=${platform} arch=${arch}`)
}

export function isSupportedPlatform(value: string): value is PlatformTriple {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value)
}

async function githubFetch<T>(path: string): Promise<T> {
  const url = new URL(path, 'https://api.github.com').toString()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'temporal-bun-sdk-download-client',
  }

  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(url, { headers })

  if (response.status === 404) {
    throw new Error(`Release not found at ${url}`)
  }

  if (response.status === 403) {
    const remaining = response.headers.get('X-RateLimit-Remaining')
    if (remaining === '0') {
      throw new Error('GitHub API rate limit exceeded. Provide GITHUB_TOKEN or GH_TOKEN to increase the limit.')
    }
    throw new Error('GitHub request forbidden. Ensure the repository is accessible and credentials are valid.')
  }

  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as T
}

export async function fetchRelease(tag: string): Promise<ReleaseResponse> {
  const normalized = tag.startsWith('temporal-libs-') ? tag : `temporal-libs-${tag}`
  return githubFetch<ReleaseResponse>(`/repos/${OWNER}/${REPO}/releases/tags/${normalized}`)
}

export function getAssetNames(platform: PlatformTriple, tag: string): { archive: string; checksum: string } {
  const versionLabel = tag.replace(/^temporal-libs-/, '')
  const archive = `temporal-static-libs-${platform}-${versionLabel}.tar.gz`
  return { archive, checksum: `${archive}.sha256` }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function downloadToFile(url: string, targetPath: string, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { headers })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  await ensureDir(dirname(targetPath))
  const fileStream = createWriteStream(targetPath)
  const nodeStream = Readable.fromWeb(response.body as unknown as ReadableStream)
  await pipeline(nodeStream, fileStream)
}

async function computeSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function extractTarball(tarPath: string, destination: string): Promise<void> {
  await ensureDir(destination)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destination])
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with code ${code}`))
    })
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function createLatestSymlink(versionTag: string): Promise<void> {
  const latestPath = join(CACHE_ROOT, 'latest')
  try {
    await rm(latestPath, { force: true })
  } catch {
    // ignore removal errors
  }
  try {
    await symlink(versionTag, latestPath)
  } catch (error) {
    console.warn('Unable to create latest symlink:', error)
  }
}

export async function downloadLibraries(versionTag: string, platform: PlatformTriple): Promise<void> {
  console.log(`Resolving release ${versionTag} for ${platform}…`)
  const release = await fetchRelease(versionTag)
  console.log(`Found release: ${release.tag_name}`)

  await ensureDir(CACHE_ROOT)

  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'temporal-bun-sdk-download-client',
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const { archive, checksum } = getAssetNames(platform, release.tag_name)
  const archiveAsset = release.assets.find((asset) => asset.name === archive)
  const checksumAsset = release.assets.find((asset) => asset.name === checksum)

  if (!archiveAsset || !checksumAsset) {
    throw new Error(`Release ${release.tag_name} is missing required assets for ${platform}`)
  }

  const versionDir = join(CACHE_ROOT, release.tag_name, platform)
  const downloadsDir = join(CACHE_ROOT, 'downloads')
  const archivePath = join(downloadsDir, archive)
  const checksumPath = join(downloadsDir, checksum)

  console.log(`Downloading ${archive}…`)
  await downloadToFile(archiveAsset.browser_download_url, archivePath, headers)
  console.log(`Saved archive to ${archivePath}`)

  console.log(`Downloading checksum ${checksum}…`)
  await downloadToFile(checksumAsset.browser_download_url, checksumPath, headers)

  const checksumLine = (await Bun.file(checksumPath).text()).trim().split(/\r?\n/)[0] ?? ''
  const expectedChecksum = checksumLine.split(/\s+/)[0]
  if (!expectedChecksum) {
    throw new Error('Checksum file did not contain a hash value')
  }

  const actualChecksum = await computeSha256(archivePath)
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${archive}: expected ${expectedChecksum} but got ${actualChecksum}`)
  }
  console.log('Checksum verified')

  if (await pathExists(versionDir)) {
    console.log(`Removing existing cache at ${versionDir}`)
    await rm(versionDir, { recursive: true, force: true })
  }

  console.log(`Extracting archive to ${versionDir}…`)
  await extractTarball(archivePath, versionDir)

  await createLatestSymlink(release.tag_name)

  console.log('Downloaded libraries:')
  console.log(`  Version: ${release.tag_name}`)
  console.log(`  Platform: ${platform}`)
  console.log(`  Location: ${join(CACHE_ROOT, release.tag_name, platform)}`)
}

export async function runCli(args: string[]): Promise<void> {
  const [command = 'download', versionArg, platformArg] = args

  if (command !== 'download') {
    console.log('Usage: bun run download-temporal-libs.ts download [version] [platform]')
    console.log(`Default version: ${DEFAULT_TAG}`)
    console.log('Supported platforms: linux-arm64, linux-x64, macos-arm64')
    return
  }

  let versionTag = versionArg ?? DEFAULT_TAG
  if (versionTag === 'latest') {
    versionTag = DEFAULT_TAG
  }

  let platform: PlatformTriple
  if (platformArg) {
    if (!isSupportedPlatform(platformArg)) {
      throw new Error(`Unsupported platform override: ${platformArg}`)
    }
    platform = platformArg
  } else {
    platform = detectPlatform()
  }

  await downloadLibraries(versionTag, platform)
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error('✗ Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
