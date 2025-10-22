#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
// Download client for Temporal static libraries
import { join } from 'node:path'

interface PlatformInfo {
  os: 'linux' | 'macos' | 'windows'
  arch: 'arm64' | 'x64'
  platform: string
}

interface LibrarySet {
  platform: string
  architecture: string
  version: string
  libraries: StaticLibrary[]
}

interface StaticLibrary {
  name: string
  path: string
  checksum: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}

interface Release {
  assets: ReleaseAsset[]
  tag_name?: string
}

interface ReleaseSummary {
  tag_name?: string
  url: string
}

interface DownloadClient {
  downloadLibraries(version?: string): Promise<LibrarySet>
  detectPlatform(): PlatformInfo
}

class TemporalLibsDownloadClient implements DownloadClient {
  private cacheDir: string
  private baseUrl: string
  private ownerRepo: string

  constructor(
    cacheDir: string = '.temporal-libs-cache',
    baseUrl: string = 'https://api.github.com',
    ownerRepo: string = process.env.TEMPORAL_LIBS_REPO ?? 'proompteng/lab',
  ) {
    this.cacheDir = cacheDir
    this.baseUrl = baseUrl
    this.ownerRepo = ownerRepo
  }

  detectPlatform(): PlatformInfo {
    const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const platform = `${os}-${arch}`

    return { os, arch, platform }
  }

  async downloadLibraries(version: string = 'latest'): Promise<LibrarySet> {
    const platform = this.detectPlatform()

    try {
      // Get release info
      const release = await this.getReleaseInfo(version)
      const resolvedVersion = this.resolveVersion(version, release)

      // Check cache after resolving actual version
      const cached = this.getCachedLibraries(resolvedVersion)
      if (cached) {
        console.log(`Using cached libraries for ${platform.platform} ${resolvedVersion}`)
        return cached
      }

      console.log(`Downloading libraries for ${platform.platform} ${resolvedVersion}`)

      const asset = this.findAssetForPlatform(release, platform.platform)

      if (!asset) {
        throw new Error(`No asset found for platform ${platform.platform}`)
      }

      // Download the asset
      const downloadPath = await this.downloadAsset(asset, resolvedVersion)

      // Verify checksum
      const checksumAsset = this.findChecksumAsset(release, platform.platform)
      if (checksumAsset) {
        const checksumPath = await this.downloadAsset(checksumAsset, resolvedVersion)
        await this.verifyChecksumFile(downloadPath, checksumPath)
      }

      // Extract and cache
      const librarySet = await this.extractAndCache(downloadPath, platform.platform, resolvedVersion)

      return librarySet
    } catch (error) {
      console.error('Failed to download libraries:', error)
      throw error
    }
  }

  getCachedLibraries(version: string): LibrarySet | null {
    const platform = this.detectPlatform()
    const cachePath = join(this.cacheDir, version, platform.platform)

    if (!existsSync(cachePath)) {
      return null
    }

    try {
      const manifestPath = join(cachePath, 'manifest.json')
      if (!existsSync(manifestPath)) {
        return null
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      return manifest
    } catch (error) {
      console.warn('Failed to read cached libraries:', error)
      return null
    }
  }

  verifyChecksum(filePath: string, expectedChecksum: string): boolean {
    try {
      const fileContent = readFileSync(filePath)
      const hash = createHash('sha256').update(fileContent).digest('hex')
      return hash === expectedChecksum
    } catch (error) {
      console.error('Failed to verify checksum:', error)
      return false
    }
  }

  private async getReleaseInfo(version: string): Promise<Release> {
    const repoBase = `${this.baseUrl}/repos/${this.ownerRepo}`

    if (version === 'latest') {
      const releaseUrl = await this.findLatestTemporalLibsReleaseUrl(repoBase)
      if (!releaseUrl) {
        throw new Error('Failed to locate latest Temporal static libraries release')
      }
      return await this.fetchRelease(releaseUrl)
    }

    return await this.fetchRelease(`${repoBase}/releases/tags/${this.resolveTag(version)}`)
  }

  private resolveTag(version: string): string {
    if (version.startsWith('temporal-libs-')) {
      return version
    }
    if (version.startsWith('v')) {
      return `temporal-libs-${version}`
    }
    return `temporal-libs-v${version}`
  }

  private resolveVersion(requestedVersion: string, release: Release): string {
    if (requestedVersion === 'latest') {
      return release.tag_name ?? 'latest'
    }
    if (release.tag_name) {
      return release.tag_name
    }
    return this.resolveTag(requestedVersion)
  }

  private async findLatestTemporalLibsReleaseUrl(repoBase: string): Promise<string | undefined> {
    const perPage = 50
    for (let page = 1; page <= 5; page++) {
      const response = await this.githubFetch(`${repoBase}/releases?per_page=${perPage}&page=${page}`)
      if (!response.ok) {
        throw new Error(`Failed to list releases: ${response.statusText}`)
      }
      const releases = (await response.json()) as ReleaseSummary[]
      const match = releases.find((rel) => rel.tag_name?.startsWith('temporal-libs-'))
      if (match) {
        return match.url
      }
      if (releases.length < perPage) {
        break
      }
    }
    return undefined
  }

  private async fetchRelease(url: string): Promise<Release> {
    const response = await this.githubFetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch release info: ${response.statusText}`)
    }
    return (await response.json()) as Release
  }

  private findAssetForPlatform(release: Release, platform: string): ReleaseAsset | undefined {
    return release.assets.find(
      (asset) => asset.name.includes(`temporal-static-libs-${platform}`) && asset.name.endsWith('.tar.gz'),
    )
  }

  private findChecksumAsset(release: Release, platform: string): ReleaseAsset | undefined {
    return release.assets.find(
      (asset) => asset.name.includes(`temporal-static-libs-${platform}`) && asset.name.endsWith('.sha256'),
    )
  }

  private async downloadAsset(asset: ReleaseAsset, version: string): Promise<string> {
    const response = await fetch(asset.browser_download_url)
    if (!response.ok) {
      throw new Error(`Failed to download asset: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    const downloadDir = join(this.cacheDir, 'downloads', version)
    const downloadPath = join(downloadDir, asset.name)

    mkdirSync(downloadDir, { recursive: true })
    writeFileSync(downloadPath, Buffer.from(buffer))

    return downloadPath
  }

  private async verifyChecksumFile(downloadPath: string, checksumPath: string): Promise<void> {
    const checksumContent = readFileSync(checksumPath, 'utf8')
    const expectedChecksum = checksumContent.split(' ')[0]

    if (!this.verifyChecksum(downloadPath, expectedChecksum)) {
      throw new Error('Checksum verification failed')
    }
  }

  private async extractAndCache(_downloadPath: string, platform: string, version: string): Promise<LibrarySet> {
    // Mock extraction - in real implementation, would extract tar.gz
    const cachePath = join(this.cacheDir, version, platform)
    mkdirSync(cachePath, { recursive: true })

    const librarySet: LibrarySet = {
      platform,
      architecture: platform.split('-')[1],
      version,
      libraries: [
        {
          name: 'libtemporal_sdk_core.a',
          path: join(cachePath, 'libtemporal_sdk_core.a'),
          checksum: 'mock-checksum-1',
        },
        {
          name: 'libtemporal_client.a',
          path: join(cachePath, 'libtemporal_client.a'),
          checksum: 'mock-checksum-2',
        },
      ],
    }

    // Write manifest
    const manifestPath = join(cachePath, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(librarySet, null, 2))

    return librarySet
  }

  private async githubFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: HeadersInit = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'temporal-bun-sdk-download',
    }

    const token = process.env.TEMPORAL_LIBS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    return await fetch(url, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
    })
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2)

  const version = (() => {
    if (args.length === 0) {
      return 'latest'
    }
    if (args[0] === 'download') {
      return args[1] ?? 'latest'
    }
    return args[0]
  })()

  const client = new TemporalLibsDownloadClient()

  try {
    const libraries = await client.downloadLibraries(version)
    console.log('Downloaded libraries:', libraries)
  } catch (error) {
    console.error('Download failed:', error)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}

export { TemporalLibsDownloadClient, type DownloadClient, type LibrarySet, type StaticLibrary, type PlatformInfo }
