#!/usr/bin/env bun

/**
 * Download client for Temporal static libraries
 * Fetches pre-built static libraries from GitHub releases
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  createWriteStream,
  rmSync,
  readdirSync,
  statSync,
} from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'

// Error types for better error handling
export class TemporalLibsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = 'TemporalLibsError'
  }
}

export class NetworkError extends TemporalLibsError {
  constructor(message: string, cause?: Error) {
    super(message, 'NETWORK_ERROR', cause)
    this.name = 'NetworkError'
  }
}

export class RateLimitError extends TemporalLibsError {
  constructor(
    message: string,
    public readonly resetTime?: Date,
    cause?: Error,
  ) {
    super(message, 'RATE_LIMIT_ERROR', cause)
    this.name = 'RateLimitError'
  }
}

export class ChecksumError extends TemporalLibsError {
  constructor(
    message: string,
    public readonly expected?: string,
    public readonly actual?: string,
    cause?: Error,
  ) {
    super(message, 'CHECKSUM_ERROR', cause)
    this.name = 'ChecksumError'
  }
}

export class PlatformError extends TemporalLibsError {
  constructor(
    message: string,
    public readonly platform?: string,
    cause?: Error,
  ) {
    super(message, 'PLATFORM_ERROR', cause)
    this.name = 'PlatformError'
  }
}

export class ArtifactNotFoundError extends TemporalLibsError {
  constructor(
    message: string,
    public readonly version?: string,
    public readonly platform?: string,
    cause?: Error,
  ) {
    super(message, 'ARTIFACT_NOT_FOUND', cause)
    this.name = 'ArtifactNotFoundError'
  }
}

export class CacheError extends TemporalLibsError {
  constructor(message: string, cause?: Error) {
    super(message, 'CACHE_ERROR', cause)
    this.name = 'CacheError'
  }
}

export class FallbackError extends TemporalLibsError {
  constructor(
    message: string,
    public readonly originalError: Error,
    cause?: Error,
  ) {
    super(message, 'FALLBACK_ERROR', cause)
    this.name = 'FallbackError'
  }
}

// Types and interfaces
export interface PlatformInfo {
  os: 'linux' | 'macos' | 'windows'
  arch: 'arm64' | 'x64'
  platform: string // Combined os-arch string
}

export interface StaticLibrary {
  name: string
  path: string
  checksum: string
}

export interface LibrarySet {
  platform: string
  architecture: string
  version: string
  libraries: StaticLibrary[]
}

export interface GitHubRelease {
  tag_name: string
  name: string
  assets: GitHubAsset[]
}

export interface GitHubAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface TemporalLibsConfig {
  version?: string
  cacheDir: string
  fallbackToCompilation: boolean
  checksumVerification: boolean
  retryAttempts: number
  retryDelayMs: number
  maxRetryDelayMs: number
  maxDownloadSizeMB: number
  resumeDownloads: boolean
  rateLimitRetryDelayMs: number
  maxRateLimitRetries: number
}

// Default configuration
const DEFAULT_CONFIG: TemporalLibsConfig = {
  version: 'latest',
  cacheDir: '.temporal-libs-cache',
  fallbackToCompilation: true,
  checksumVerification: true,
  retryAttempts: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 30000, // Cap exponential backoff at 30 seconds
  maxDownloadSizeMB: 100,
  resumeDownloads: true,
  rateLimitRetryDelayMs: 60000, // Wait 1 minute for rate limit resets
  maxRateLimitRetries: 5, // Maximum rate limit retries
}

/**
 * Platform detection utility
 */
export const PlatformDetector = {
  detectPlatform(): PlatformInfo {
    // Check for forced platform/arch from environment (used for cross-compilation)
    const forcePlatform = process.env.FORCE_PLATFORM
    const forceArch = process.env.FORCE_ARCH

    let platform = process.platform
    let arch = process.arch

    // Override with forced values if provided
    if (forcePlatform) {
      platform = forcePlatform
    }
    if (forceArch) {
      arch = forceArch
    }

    let os: PlatformInfo['os']
    let normalizedArch: PlatformInfo['arch']

    // Normalize OS
    switch (platform) {
      case 'linux':
        os = 'linux'
        break
      case 'darwin':
        os = 'macos'
        break
      case 'win32':
        os = 'windows'
        break
      default:
        throw new Error(`Unsupported platform: ${platform}`)
    }

    // Normalize architecture
    switch (arch) {
      case 'arm64':
        normalizedArch = 'arm64'
        break
      case 'x64':
      case 'x86_64':
        normalizedArch = 'x64'
        break
      default:
        throw new Error(`Unsupported architecture: ${arch}`)
    }

    const platformInfo = {
      os,
      arch: normalizedArch,
      platform: `${os}-${normalizedArch}`,
    }

    // Log if we're using forced platform detection
    if (forcePlatform || forceArch) {
      console.log(
        `Using forced platform detection: ${platformInfo.platform} (original: ${process.platform}-${process.arch})`,
      )
    }

    return platformInfo
  },

  isSupported(platformInfo: PlatformInfo): boolean {
    const supportedPlatforms = ['linux-arm64', 'linux-x64', 'macos-arm64']
    return supportedPlatforms.includes(platformInfo.platform)
  },
}

/**
 * GitHub API client for fetching releases and artifacts
 */
export class GitHubApiClient {
  private readonly baseUrl = 'https://api.github.com'
  private readonly owner: string
  private readonly repo: string
  private readonly config: TemporalLibsConfig

  constructor(owner: string, repo: string, config: TemporalLibsConfig = DEFAULT_CONFIG) {
    this.owner = owner
    this.repo = repo
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Fetch releases from GitHub API with comprehensive retry logic and rate limiting
   */
  async fetchReleases(): Promise<GitHubRelease[]> {
    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/releases`
    let rateLimitRetries = 0

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        console.log(`Fetching releases from ${url} (attempt ${attempt}/${this.config.retryAttempts})`)

        const response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'temporal-bun-sdk-download-client',
          },
        })

        // Handle rate limiting with special retry logic
        if (response.status === 403) {
          const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining')
          const rateLimitReset = response.headers.get('X-RateLimit-Reset')

          if (rateLimitRemaining === '0' || response.headers.get('X-RateLimit-Exceeded')) {
            rateLimitRetries++

            if (rateLimitRetries > this.config.maxRateLimitRetries) {
              throw new RateLimitError(
                `GitHub API rate limit exceeded after ${this.config.maxRateLimitRetries} rate limit retries`,
                rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000) : undefined,
              )
            }

            let waitTime = this.config.rateLimitRetryDelayMs

            if (rateLimitReset) {
              const resetTime = new Date(parseInt(rateLimitReset) * 1000)
              const now = new Date()
              const timeUntilReset = resetTime.getTime() - now.getTime()

              if (timeUntilReset > 0 && timeUntilReset < this.config.rateLimitRetryDelayMs * 2) {
                waitTime = timeUntilReset + 5000 // Add 5 second buffer
              }

              console.log(
                `⚠️  GitHub API rate limit exceeded. Waiting ${Math.round(waitTime / 1000)}s until reset at ${resetTime.toISOString()}`,
              )
            } else {
              console.log(`⚠️  GitHub API rate limit exceeded. Waiting ${Math.round(waitTime / 1000)}s before retry`)
            }

            await new Promise((resolve) => setTimeout(resolve, waitTime))
            continue // Don't count this as a regular retry attempt
          } else {
            // Other 403 error (permissions, etc.)
            throw new NetworkError(
              `Access denied to repository ${this.owner}/${this.repo}. Check if the repository is public or if you need authentication.`,
            )
          }
        }

        if (!response.ok) {
          if (response.status === 404) {
            throw new ArtifactNotFoundError(`Repository ${this.owner}/${this.repo} not found or not accessible`)
          }

          if (response.status >= 500) {
            // Server error - retry with exponential backoff
            throw new NetworkError(`GitHub API server error: ${response.status} ${response.statusText}`)
          }

          // Client error - don't retry
          throw new NetworkError(`GitHub API request failed: ${response.status} ${response.statusText}`)
        }

        const releases: GitHubRelease[] = await response.json()
        console.log(`✓ Successfully fetched ${releases.length} releases`)

        // Log rate limit status for monitoring
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining')
        const rateLimitLimit = response.headers.get('X-RateLimit-Limit')
        if (rateLimitRemaining && rateLimitLimit) {
          console.log(`GitHub API rate limit: ${rateLimitRemaining}/${rateLimitLimit} remaining`)
        }

        return releases
      } catch (error) {
        // Don't retry for certain error types
        if (
          error instanceof ArtifactNotFoundError ||
          (error instanceof NetworkError && error.message.includes('Access denied'))
        ) {
          throw error
        }

        // Don't retry rate limit errors that have exceeded max retries
        if (error instanceof RateLimitError) {
          throw error
        }

        console.error(`✗ Attempt ${attempt} failed:`, error instanceof Error ? error.message : error)

        if (attempt === this.config.retryAttempts) {
          if (error instanceof Error) {
            throw new NetworkError(
              `Failed to fetch releases after ${this.config.retryAttempts} attempts: ${error.message}`,
              error,
            )
          } else {
            throw new NetworkError(`Failed to fetch releases after ${this.config.retryAttempts} attempts: ${error}`)
          }
        }

        // Exponential backoff with jitter and cap
        const baseDelay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
        const jitter = Math.random() * 0.1 * baseDelay // Add up to 10% jitter
        const delay = Math.min(baseDelay + jitter, this.config.maxRetryDelayMs)

        console.log(`Retrying in ${Math.round(delay)}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw new NetworkError('All retry attempts failed')
  }

  /**
   * Find the appropriate release based on version with enhanced error handling
   */
  async findRelease(version: string = 'latest'): Promise<GitHubRelease | null> {
    try {
      const releases = await this.fetchReleases()

      if (releases.length === 0) {
        throw new ArtifactNotFoundError(`No releases found in repository ${this.owner}/${this.repo}`)
      }

      if (version === 'latest') {
        // Filter for temporal-libs releases and get the latest
        const temporalReleases = releases.filter((release) => release.tag_name.startsWith('temporal-libs-'))

        if (temporalReleases.length === 0) {
          throw new ArtifactNotFoundError(
            `No temporal-libs releases found in repository ${this.owner}/${this.repo}. ` +
              `Available releases: ${releases
                .slice(0, 5)
                .map((r) => r.tag_name)
                .join(', ')}${releases.length > 5 ? '...' : ''}\n\n` +
              `To create a temporal-libs release:\n` +
              `  gh release create temporal-libs-v1.0.0 --title "Temporal Static Libraries v1.0.0" --notes "Pre-built libraries"`,
          )
        }

        console.log(`Found latest temporal-libs release: ${temporalReleases[0].tag_name}`)
        return temporalReleases[0]
      }

      // Find specific version
      const targetTag = version.startsWith('temporal-libs-') ? version : `temporal-libs-${version}`
      const release = releases.find((release) => release.tag_name === targetTag)

      if (!release) {
        const temporalReleases = releases.filter((r) => r.tag_name.startsWith('temporal-libs-'))
        const availableVersions = temporalReleases
          .slice(0, 10)
          .map((r) => r.tag_name)
          .join(', ')

        throw new ArtifactNotFoundError(
          `Release ${targetTag} not found in repository ${this.owner}/${this.repo}. ` +
            `Available temporal-libs versions: ${availableVersions}${temporalReleases.length > 10 ? '...' : ''}`,
          version,
        )
      }

      console.log(`Found specific release: ${release.tag_name}`)
      return release
    } catch (error) {
      if (error instanceof TemporalLibsError) {
        throw error
      }

      throw new NetworkError(
        `Failed to find release ${version}: ${error instanceof Error ? error.message : error}`,
        error instanceof Error ? error : undefined,
      )
    }
  }

  /**
   * Find artifacts for a specific platform in a release with enhanced error reporting
   */
  findPlatformArtifacts(
    release: GitHubRelease,
    platformInfo: PlatformInfo,
  ): {
    libraryAsset: GitHubAsset | null
    checksumAsset: GitHubAsset | null
    availablePlatforms: string[]
  } {
    const platformString = platformInfo.platform

    const libraryAsset =
      release.assets.find(
        (asset) => asset.name.includes(`temporal-static-libs-${platformString}`) && asset.name.endsWith('.tar.gz'),
      ) || null

    const checksumAsset =
      release.assets.find(
        (asset) => asset.name.includes(`temporal-static-libs-${platformString}`) && asset.name.endsWith('.sha256'),
      ) || null

    // Extract available platforms from asset names for better error reporting
    const availablePlatforms = release.assets
      .filter((asset) => asset.name.startsWith('temporal-static-libs-') && asset.name.endsWith('.tar.gz'))
      .map((asset) => {
        const match = asset.name.match(/temporal-static-libs-([^-]+-[^-]+)-/)
        return match ? match[1] : null
      })
      .filter((platform): platform is string => platform !== null)
      .filter((platform, index, array) => array.indexOf(platform) === index) // Remove duplicates

    return { libraryAsset, checksumAsset, availablePlatforms }
  }
}

/**
 * File download and verification utilities
 */
export class FileDownloader {
  private readonly config: TemporalLibsConfig

  constructor(config: TemporalLibsConfig) {
    this.config = config
  }

  /**
   * Download a file with progress reporting and resume capability
   */
  async downloadFile(url: string, outputPath: string, expectedSize?: number): Promise<void> {
    // Ensure output directory exists
    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    // Check if file already exists and get its size for resume
    let startByte = 0
    if (this.config.resumeDownloads && existsSync(outputPath)) {
      try {
        const stats = statSync(outputPath)
        startByte = stats.size
        if (startByte > 0) {
          console.log(`Resuming download from byte ${startByte} (${Math.round(startByte / 1024)}KB)`)
        }
      } catch (error) {
        console.warn(`Could not get file stats for resume, starting fresh: ${error}`)
        startByte = 0
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': 'temporal-bun-sdk-download-client',
      Accept: '*/*',
    }

    // Add range header for resume
    if (startByte > 0) {
      headers['Range'] = `bytes=${startByte}-`
    }

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        console.log(`Downloading ${url} (attempt ${attempt}/${this.config.retryAttempts})`)

        const response = await fetch(url, { headers })

        if (!response.ok) {
          if (response.status === 416 && startByte > 0) {
            // Range not satisfiable - file might be complete
            console.log('✓ File appears to be already complete')
            return
          }

          if (response.status === 404) {
            throw new ArtifactNotFoundError(`File not found: ${url}`)
          }

          if (response.status === 403) {
            throw new NetworkError(
              `Access denied: ${url}. Check if the release is public or if you need authentication.`,
            )
          }

          if (response.status === 429) {
            // Rate limited
            const retryAfter = response.headers.get('Retry-After')
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : this.config.rateLimitRetryDelayMs
            throw new RateLimitError(`Download rate limited. Retry after ${Math.round(waitTime / 1000)}s`)
          }

          if (response.status >= 500) {
            // Server error - retryable
            throw new NetworkError(`Server error during download: ${response.status} ${response.statusText}`)
          }

          // Client error - not retryable
          throw new NetworkError(`Download failed: ${response.status} ${response.statusText}`)
        }

        const contentLength = response.headers.get('content-length')
        const partialSize = contentLength ? parseInt(contentLength) : 0
        const totalSize = partialSize + startByte

        // Validate expected size if provided
        if (expectedSize && totalSize !== expectedSize && startByte === 0) {
          console.warn(`Warning: Expected size ${expectedSize} bytes, but server reports ${totalSize} bytes`)
        }

        // Check file size limit
        if (totalSize > this.config.maxDownloadSizeMB * 1024 * 1024) {
          throw new Error(
            `File size ${Math.round(totalSize / 1024 / 1024)}MB exceeds limit of ${this.config.maxDownloadSizeMB}MB`,
          )
        }

        if (!response.body) {
          throw new Error('Response body is null - server did not provide file content')
        }

        // Create write stream (append mode for resume)
        const writeStream = createWriteStream(outputPath, {
          flags: startByte > 0 ? 'a' : 'w',
        })

        let downloadedBytes = startByte
        let lastProgressUpdate = Date.now()
        const reader = response.body.getReader()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            writeStream.write(value)
            downloadedBytes += value.length

            // Progress reporting with throttling (update every 100ms)
            const now = Date.now()
            if (now - lastProgressUpdate > 100 || downloadedBytes === totalSize) {
              if (totalSize > 0) {
                const progress = Math.round((downloadedBytes / totalSize) * 100)
                const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1)
                const totalMB = (totalSize / 1024 / 1024).toFixed(1)
                process.stdout.write(`\rProgress: ${progress}% (${downloadedMB}MB / ${totalMB}MB)`)
              } else {
                const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1)
                process.stdout.write(`\rDownloaded: ${downloadedMB}MB`)
              }
              lastProgressUpdate = now
            }
          }
        } finally {
          reader.releaseLock()
          writeStream.end()

          // Wait for write stream to finish
          await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve)
            writeStream.on('error', reject)
          })
        }

        console.log(`\n✓ Download completed: ${outputPath} (${Math.round(downloadedBytes / 1024 / 1024)}MB)`)
        return
      } catch (error) {
        console.error(`\n✗ Attempt ${attempt} failed:`, error instanceof Error ? error.message : error)

        // Don't retry for certain error types
        if (error instanceof ArtifactNotFoundError) {
          throw error
        }

        // Handle rate limiting with special retry logic
        if (error instanceof RateLimitError) {
          if (attempt < this.config.retryAttempts) {
            console.log(`Rate limited, waiting before retry...`)
            await new Promise((resolve) => setTimeout(resolve, this.config.rateLimitRetryDelayMs))
            continue
          } else {
            throw error
          }
        }

        // Clean up partial file on final failure or non-retryable errors
        if (
          (attempt === this.config.retryAttempts ||
            (error instanceof NetworkError && !error.message.includes('Server error'))) &&
          existsSync(outputPath)
        ) {
          try {
            rmSync(outputPath)
            console.log('Cleaned up partial download file')
          } catch (cleanupError) {
            console.warn('Could not clean up partial file:', cleanupError)
          }
        }

        if (attempt === this.config.retryAttempts) {
          if (error instanceof TemporalLibsError) {
            throw error
          }
          throw new NetworkError(
            `Download failed after ${this.config.retryAttempts} attempts: ${error instanceof Error ? error.message : error}`,
            error instanceof Error ? error : undefined,
          )
        }

        // Only retry for network errors and server errors
        if (error instanceof NetworkError && error.message.includes('Server error')) {
          // Exponential backoff with jitter and cap
          const baseDelay = this.config.retryDelayMs * Math.pow(2, attempt - 1)
          const jitter = Math.random() * 0.1 * baseDelay // Add up to 10% jitter
          const delay = Math.min(Math.round(baseDelay + jitter), this.config.maxRetryDelayMs)

          console.log(`Retrying in ${Math.round(delay / 1000)}s...`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        } else {
          // Non-retryable error
          throw error instanceof TemporalLibsError
            ? error
            : new NetworkError(
                `Download failed: ${error instanceof Error ? error.message : error}`,
                error instanceof Error ? error : undefined,
              )
        }
      }
    }
  }

  /**
   * Calculate SHA256 checksum of a file
   */
  async calculateChecksum(filePath: string): Promise<string> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const fileBuffer = readFileSync(filePath)
    const hash = createHash('sha256')
    hash.update(fileBuffer)
    return hash.digest('hex')
  }

  /**
   * Verify file checksum against expected value with enhanced error handling
   */
  async verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
    try {
      if (!existsSync(filePath)) {
        throw new ChecksumError(`Cannot verify checksum: file not found: ${filePath}`)
      }

      const stats = statSync(filePath)
      if (stats.size === 0) {
        throw new ChecksumError(`Cannot verify checksum: file is empty: ${filePath}`)
      }

      console.log(`Calculating checksum for ${filePath} (${Math.round(stats.size / 1024 / 1024)}MB)...`)
      const actualChecksum = await this.calculateChecksum(filePath)
      const normalizedExpected = expectedChecksum.toLowerCase().trim()
      const normalizedActual = actualChecksum.toLowerCase().trim()

      // Validate checksum format
      if (!/^[a-fA-F0-9]{64}$/.test(normalizedExpected)) {
        throw new ChecksumError(`Invalid expected checksum format: "${expectedChecksum}" (expected 64 hex characters)`)
      }

      const match = normalizedActual === normalizedExpected

      if (match) {
        console.log(`✓ Checksum verification passed for ${filePath}`)
        console.log(`  SHA256: ${normalizedActual}`)
        return true
      } else {
        const error = new ChecksumError(
          `Checksum verification failed for ${filePath}. The file may be corrupted or tampered with.`,
          normalizedExpected,
          normalizedActual,
        )

        console.error(`✗ ${error.message}`)
        console.error(`  Expected: ${normalizedExpected}`)
        console.error(`  Actual:   ${normalizedActual}`)

        throw error
      }
    } catch (error) {
      if (error instanceof ChecksumError) {
        throw error
      }

      const checksumError = new ChecksumError(
        `Error verifying checksum for ${filePath}: ${error instanceof Error ? error.message : error}`,
        expectedChecksum,
        undefined,
        error instanceof Error ? error : undefined,
      )

      console.error(`✗ ${checksumError.message}`)
      throw checksumError
    }
  }

  /**
   * Download and verify checksum file
   */
  async downloadChecksum(url: string, outputPath: string): Promise<string> {
    try {
      await this.downloadFile(url, outputPath)

      if (!existsSync(outputPath)) {
        throw new Error(`Checksum file was not created: ${outputPath}`)
      }

      const checksumContent = readFileSync(outputPath, 'utf-8').trim()

      if (!checksumContent) {
        throw new Error('Checksum file is empty')
      }

      // Parse checksum file (format: "checksum filename" or just "checksum")
      const parts = checksumContent.split(/\s+/)
      if (parts.length < 1) {
        throw new Error(`Invalid checksum file format: "${checksumContent}"`)
      }

      const checksum = parts[0]

      // Validate checksum format (SHA256 should be 64 hex characters)
      if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
        throw new Error(`Invalid SHA256 checksum format: "${checksum}" (expected 64 hex characters)`)
      }

      return checksum
    } catch (error) {
      // Clean up partial checksum file on error
      if (existsSync(outputPath)) {
        try {
          rmSync(outputPath)
        } catch (cleanupError) {
          console.warn('Could not clean up partial checksum file:', cleanupError)
        }
      }

      if (error instanceof Error) {
        throw new Error(`Failed to download checksum: ${error.message}`)
      } else {
        throw new Error(`Failed to download checksum: ${error}`)
      }
    }
  }

  /**
   * Extract tar.gz archive with progress reporting
   */
  async extractArchive(archivePath: string, extractDir: string): Promise<void> {
    if (!existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`)
    }

    const stats = statSync(archivePath)
    if (stats.size === 0) {
      throw new Error(`Archive is empty: ${archivePath}`)
    }

    // Ensure extract directory exists
    if (!existsSync(extractDir)) {
      mkdirSync(extractDir, { recursive: true })
    }

    const archiveSizeMB = Math.round(stats.size / 1024 / 1024)
    console.log(`Extracting ${archivePath} (${archiveSizeMB}MB) to ${extractDir}...`)

    try {
      // Use tar command with verbose output for progress
      const proc = Bun.spawn(['tar', '-xzf', archivePath, '-C', extractDir, '--verbose'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Monitor extraction progress
      const stdout = proc.stdout
      const stderr = proc.stderr

      let extractedFiles = 0
      const progressInterval = setInterval(() => {
        if (extractedFiles > 0) {
          process.stdout.write(`\rExtracting... ${extractedFiles} files processed`)
        }
      }, 500)

      // Read stdout for file list
      if (stdout) {
        const reader = stdout.getReader()
        const decoder = new TextDecoder()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const output = decoder.decode(value)
            const lines = output.split('\n').filter((line) => line.trim())
            extractedFiles += lines.length
          }
        } finally {
          reader.releaseLock()
        }
      }

      const exitCode = await proc.exited
      clearInterval(progressInterval)

      if (exitCode !== 0) {
        let errorMessage = `Extraction failed with exit code ${exitCode}`

        if (stderr) {
          try {
            const stderrText = await new Response(stderr).text()
            if (stderrText.trim()) {
              errorMessage += `\nError details: ${stderrText}`
            }
          } catch (stderrError) {
            console.warn('Could not read stderr:', stderrError)
          }
        }

        throw new Error(errorMessage)
      }

      // Verify extraction was successful
      const extractedEntries = readdirSync(extractDir)
      if (extractedEntries.length === 0) {
        throw new Error('Archive extraction completed but no files were extracted')
      }

      console.log(`\n✓ Successfully extracted ${extractedFiles} files to ${extractDir}`)
      console.log(`  Extracted entries: ${extractedEntries.length} items`)
    } catch (error) {
      // Clean up partial extraction on failure
      try {
        if (existsSync(extractDir)) {
          const entries = readdirSync(extractDir)
          if (entries.length > 0) {
            console.log('Cleaning up partial extraction...')
            rmSync(extractDir, { recursive: true, force: true })
            mkdirSync(extractDir, { recursive: true })
          }
        }
      } catch (cleanupError) {
        console.warn('Could not clean up partial extraction:', cleanupError)
      }

      if (error instanceof Error) {
        throw new Error(`Failed to extract archive: ${error.message}`)
      } else {
        throw new Error(`Failed to extract archive: ${error}`)
      }
    }
  }
}

/**
 * Cache management for downloaded libraries
 */
export class CacheManager {
  private readonly config: TemporalLibsConfig
  private readonly cacheDir: string

  constructor(config: TemporalLibsConfig) {
    this.config = config
    this.cacheDir = join(process.cwd(), config.cacheDir)
  }

  /**
   * Get cache directory path for a specific version and platform
   */
  getCacheDir(version: string, platform: string): string {
    return join(this.cacheDir, version, platform)
  }

  /**
   * Get downloads directory path
   */
  getDownloadsDir(): string {
    return join(this.cacheDir, 'downloads')
  }

  /**
   * Check if libraries are cached for a specific version and platform
   */
  isCached(version: string, platform: string): boolean {
    const cacheDir = this.getCacheDir(version, platform)

    if (!existsSync(cacheDir)) {
      return false
    }

    // Check if there are any .a files in the cache directory
    try {
      const hasLibraries = this.findLibraryFiles(cacheDir).length > 0
      if (hasLibraries) {
        console.log(`✓ Found cached libraries for ${version} (${platform})`)
      }
      return hasLibraries
    } catch (error) {
      console.warn(`Error checking cache for ${version} (${platform}):`, error)
      return false
    }
  }

  /**
   * Get cached libraries for a specific version and platform
   */
  async getCachedLibraries(version: string, platform: string): Promise<LibrarySet | null> {
    if (!this.isCached(version, platform)) {
      return null
    }

    const cacheDir = this.getCacheDir(version, platform)

    try {
      const libraryFiles = this.findLibraryFiles(cacheDir)
      const libraries: StaticLibrary[] = []

      // Load cached checksums if available for validation
      const cachedChecksums = await this.loadCachedChecksums(cacheDir)

      for (const libPath of libraryFiles) {
        const libName = libPath.split('/').pop() || ''

        // Verify cached file integrity
        if (!(await this.verifyCachedFile(libPath))) {
          console.warn(`Cached file integrity check failed: ${libPath}`)
          await this.invalidateCache(version, platform, `File integrity check failed for ${libName}`)
          return null // Cache is corrupted, need to re-download
        }

        const checksum = await this.calculateFileChecksum(libPath)

        // Verify against cached checksum if available
        if (cachedChecksums?.[libName]) {
          if (cachedChecksums[libName] !== checksum) {
            console.warn(`Cached file checksum mismatch: ${libName}`)
            console.warn(`  Expected: ${cachedChecksums[libName]}`)
            console.warn(`  Actual: ${checksum}`)
            await this.invalidateCache(version, platform, `Checksum mismatch for ${libName}`)
            return null // Cache is corrupted, need to re-download
          }
        }

        libraries.push({
          name: libName,
          path: libPath,
          checksum,
        })
      }

      const [os, arch] = platform.split('-') as [string, string]

      return {
        platform: os,
        architecture: arch,
        version,
        libraries,
      }
    } catch (error) {
      console.error(`Error loading cached libraries for ${version} (${platform}):`, error)
      await this.invalidateCache(version, platform, `Error loading cache: ${error}`)
      return null
    }
  }

  /**
   * Save library set to cache
   */
  async saveToCache(librarySet: LibrarySet): Promise<void> {
    const platform = `${librarySet.platform}-${librarySet.architecture}`
    const cacheDir = this.getCacheDir(librarySet.version, platform)

    // Ensure cache directory exists
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }

    // Create cache metadata
    const metadata = {
      version: librarySet.version,
      platform: librarySet.platform,
      architecture: librarySet.architecture,
      cachedAt: new Date().toISOString(),
      libraries: librarySet.libraries.map((lib) => ({
        name: lib.name,
        checksum: lib.checksum,
        size: existsSync(lib.path) ? statSync(lib.path).size : 0,
      })),
    }

    const metadataPath = join(cacheDir, 'cache-metadata.json')
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2))

    // Also create checksums.sha256 file as specified in design
    const checksumLines = librarySet.libraries.map((lib) => `${lib.checksum}  ${lib.name}`)
    const checksumsPath = join(cacheDir, 'checksums.sha256')
    writeFileSync(checksumsPath, checksumLines.join('\n') + '\n')

    console.log(`✓ Saved cache metadata to ${metadataPath}`)
    console.log(`✓ Saved checksums to ${checksumsPath}`)
  }

  /**
   * Clear cache for a specific version and platform
   */
  clearCache(version?: string, platform?: string): void {
    if (!version && !platform) {
      // Clear entire cache
      if (existsSync(this.cacheDir)) {
        console.log(`Clearing entire cache directory: ${this.cacheDir}`)
        rmSync(this.cacheDir, { recursive: true, force: true })
      }
      return
    }

    if (version && platform) {
      // Clear specific version and platform
      const cacheDir = this.getCacheDir(version, platform)
      if (existsSync(cacheDir)) {
        console.log(`Clearing cache for ${version} (${platform})`)
        rmSync(cacheDir, { recursive: true, force: true })
      }
      return
    }

    if (version) {
      // Clear all platforms for a specific version
      const versionDir = join(this.cacheDir, version)
      if (existsSync(versionDir)) {
        console.log(`Clearing cache for version ${version}`)
        rmSync(versionDir, { recursive: true, force: true })
      }
    }
  }

  /**
   * Clean up old cached versions, keeping only the most recent N versions
   */
  cleanupOldVersions(keepCount: number = 3): void {
    if (!existsSync(this.cacheDir)) {
      return
    }

    try {
      const entries = readdirSync(this.cacheDir, { withFileTypes: true })
      const versionDirs = entries
        .filter((entry) => entry.isDirectory() && entry.name !== 'downloads')
        .map((entry) => ({
          name: entry.name,
          path: join(this.cacheDir, entry.name),
          mtime: statSync(join(this.cacheDir, entry.name)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()) // Sort by modification time, newest first

      if (versionDirs.length <= keepCount) {
        console.log(`Cache has ${versionDirs.length} versions, no cleanup needed`)
        return
      }

      const toDelete = versionDirs.slice(keepCount)
      console.log(`Cleaning up ${toDelete.length} old cached versions...`)

      for (const dir of toDelete) {
        console.log(`Removing old cache: ${dir.name}`)
        try {
          rmSync(dir.path, { recursive: true, force: true })
        } catch (error) {
          console.error(`Failed to remove cache directory ${dir.name}:`, error)
          // Continue with other directories
        }
      }

      console.log(`✓ Cache cleanup completed, kept ${keepCount} most recent versions`)
    } catch (error) {
      console.error('Error during cache cleanup:', error)
    }
  }

  /**
   * Validate entire cache structure and repair if possible
   */
  async validateAndRepairCache(): Promise<{
    valid: number
    repaired: number
    removed: number
    errors: string[]
  }> {
    const result = {
      valid: 0,
      repaired: 0,
      removed: 0,
      errors: [] as string[],
    }

    if (!existsSync(this.cacheDir)) {
      console.log('Cache directory does not exist, nothing to validate')
      return result
    }

    console.log('Validating cache structure...')

    try {
      const entries = readdirSync(this.cacheDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'downloads') {
          continue
        }

        const versionPath = join(this.cacheDir, entry.name)
        const version = entry.name

        try {
          const platformEntries = readdirSync(versionPath, { withFileTypes: true })

          for (const platformEntry of platformEntries) {
            if (!platformEntry.isDirectory()) {
              continue
            }

            const platform = platformEntry.name
            try {
              // Check if this cache entry is valid
              const isValid = await this.validateCacheEntry(version, platform)

              if (isValid) {
                result.valid++
                console.log(`✓ Valid cache: ${version} (${platform})`)
              } else {
                console.warn(`✗ Invalid cache: ${version} (${platform}), removing...`)
                await this.invalidateCache(version, platform, 'Failed validation check')
                result.removed++
              }
            } catch (error) {
              const errorMsg = `Error validating ${version} (${platform}): ${error}`
              result.errors.push(errorMsg)
              console.error(errorMsg)

              // Remove corrupted cache entry
              try {
                await this.invalidateCache(version, platform, 'Validation error')
                result.removed++
              } catch (removeError) {
                result.errors.push(`Failed to remove corrupted cache: ${removeError}`)
              }
            }
          }

          // Remove empty version directories
          try {
            const remainingEntries = readdirSync(versionPath)
            if (remainingEntries.length === 0) {
              rmSync(versionPath, { recursive: true, force: true })
              console.log(`Removed empty version directory: ${version}`)
            }
          } catch (error) {
            result.errors.push(`Failed to clean up empty version directory ${version}: ${error}`)
          }
        } catch (error) {
          const errorMsg = `Error processing version directory ${version}: ${error}`
          result.errors.push(errorMsg)
          console.error(errorMsg)
        }
      }
    } catch (error) {
      const errorMsg = `Error during cache validation: ${error}`
      result.errors.push(errorMsg)
      console.error(errorMsg)
    }

    console.log(
      `Cache validation completed: ${result.valid} valid, ${result.removed} removed, ${result.errors.length} errors`,
    )
    return result
  }

  /**
   * Validate a specific cache entry
   */
  private async validateCacheEntry(version: string, platform: string): Promise<boolean> {
    const cacheDir = this.getCacheDir(version, platform)

    if (!existsSync(cacheDir)) {
      return false
    }

    try {
      // Check for library files
      const libraryFiles = this.findLibraryFiles(cacheDir)
      if (libraryFiles.length === 0) {
        return false
      }

      // Validate each library file
      for (const libPath of libraryFiles) {
        if (!(await this.verifyCachedFile(libPath))) {
          return false
        }
      }

      // Check metadata consistency if available
      const metadataPath = join(cacheDir, 'cache-metadata.json')
      if (existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'))

          // Validate metadata structure
          if (!metadata.version || !metadata.platform || !metadata.architecture || !metadata.libraries) {
            console.warn(`Invalid metadata structure in ${metadataPath}`)
            return false
          }

          // Check if all libraries mentioned in metadata exist
          for (const libInfo of metadata.libraries) {
            const expectedPath = join(cacheDir, libInfo.name)
            if (!existsSync(expectedPath)) {
              console.warn(`Library file missing: ${libInfo.name} (expected at ${expectedPath})`)
              return false
            }
          }
        } catch (error) {
          console.warn(`Error reading metadata ${metadataPath}: ${error}`)
          return false
        }
      }

      return true
    } catch (error) {
      console.warn(`Error validating cache entry ${version} (${platform}): ${error}`)
      return false
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalSize: number
    versionCount: number
    versions: Array<{
      version: string
      platforms: string[]
      size: number
      cachedAt?: string
    }>
  } {
    if (!existsSync(this.cacheDir)) {
      return { totalSize: 0, versionCount: 0, versions: [] }
    }

    let totalSize = 0
    const versions: Array<{
      version: string
      platforms: string[]
      size: number
      cachedAt?: string
    }> = []

    try {
      const entries = readdirSync(this.cacheDir, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'downloads') {
          continue
        }

        const versionPath = join(this.cacheDir, entry.name)
        const platforms: string[] = []
        let versionSize = 0
        let cachedAt: string | undefined

        // Scan platforms within version directory
        const platformEntries = readdirSync(versionPath, { withFileTypes: true })
        for (const platformEntry of platformEntries) {
          if (platformEntry.isDirectory()) {
            platforms.push(platformEntry.name)

            const platformPath = join(versionPath, platformEntry.name)
            versionSize += this.calculateDirectorySize(platformPath)

            // Try to get cached timestamp from metadata
            const metadataPath = join(platformPath, 'cache-metadata.json')
            if (existsSync(metadataPath)) {
              try {
                const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'))
                cachedAt = metadata.cachedAt
              } catch {
                // Ignore metadata parsing errors
              }
            }
          }
        }

        versions.push({
          version: entry.name,
          platforms,
          size: versionSize,
          cachedAt,
        })

        totalSize += versionSize
      }
    } catch (error) {
      console.error('Error calculating cache stats:', error)
    }

    return {
      totalSize,
      versionCount: versions.length,
      versions: versions.sort((a, b) => a.version.localeCompare(b.version)),
    }
  }

  /**
   * Find library files (.a) in a directory
   */
  private findLibraryFiles(dir: string): string[] {
    const libraries: string[] = []

    if (!existsSync(dir)) {
      return libraries
    }

    const scanDirectory = (currentDir: string): void => {
      try {
        const entries = readdirSync(currentDir, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name)

          if (entry.isDirectory()) {
            scanDirectory(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('.a')) {
            libraries.push(fullPath)
          }
        }
      } catch (error) {
        console.warn(`Error scanning directory ${currentDir}:`, error)
      }
    }

    scanDirectory(dir)
    return libraries
  }

  /**
   * Verify integrity of a cached file
   */
  private async verifyCachedFile(filePath: string): Promise<boolean> {
    try {
      if (!existsSync(filePath)) {
        return false
      }

      const stats = statSync(filePath)

      // Basic checks
      if (stats.size === 0) {
        return false
      }

      // File should be readable
      readFileSync(filePath, { encoding: null, flag: 'r' })

      return true
    } catch {
      return false
    }
  }

  /**
   * Calculate checksum of a file
   */
  private async calculateFileChecksum(filePath: string): Promise<string> {
    const fileBuffer = readFileSync(filePath)
    const hash = createHash('sha256')
    hash.update(fileBuffer)
    return hash.digest('hex')
  }

  /**
   * Calculate total size of a directory
   */
  private calculateDirectorySize(dir: string): number {
    let totalSize = 0

    if (!existsSync(dir)) {
      return 0
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dir, entry.name)

        if (entry.isDirectory()) {
          totalSize += this.calculateDirectorySize(fullPath)
        } else if (entry.isFile()) {
          totalSize += statSync(fullPath).size
        }
      }
    } catch (error) {
      console.warn(`Error calculating directory size for ${dir}:`, error)
    }

    return totalSize
  }

  /**
   * Load cached checksums from checksums.sha256 file
   */
  private async loadCachedChecksums(cacheDir: string): Promise<Record<string, string> | null> {
    const checksumsPath = join(cacheDir, 'checksums.sha256')

    if (!existsSync(checksumsPath)) {
      return null
    }

    try {
      const content = readFileSync(checksumsPath, 'utf-8')
      const checksums: Record<string, string> = {}

      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        const parts = trimmed.split(/\s+/)
        if (parts.length >= 2) {
          const checksum = parts[0]
          const filename = parts.slice(1).join(' ') // Handle filenames with spaces
          checksums[filename] = checksum
        }
      }

      return checksums
    } catch (error) {
      console.warn(`Error loading cached checksums from ${checksumsPath}:`, error)
      return null
    }
  }

  /**
   * Invalidate cache for a specific version and platform
   */
  private async invalidateCache(version: string, platform: string, reason: string): Promise<void> {
    const cacheDir = this.getCacheDir(version, platform)

    console.warn(`Invalidating cache for ${version} (${platform}): ${reason}`)

    try {
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true })
        console.log(`✓ Removed corrupted cache directory: ${cacheDir}`)
      }
    } catch (error) {
      console.error(`Error removing corrupted cache directory ${cacheDir}:`, error)
    }
  }
}

/**
 * Main download client class
 */
export class DownloadClient {
  private readonly config: TemporalLibsConfig
  private readonly githubClient: GitHubApiClient
  private readonly platformInfo: PlatformInfo
  private readonly fileDownloader: FileDownloader
  private readonly cacheManager: CacheManager

  constructor(owner: string = 'proompteng', repo: string = 'lab', config: Partial<TemporalLibsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.githubClient = new GitHubApiClient(owner, repo, this.config)
    this.platformInfo = PlatformDetector.detectPlatform()
    this.fileDownloader = new FileDownloader(this.config)
    this.cacheManager = new CacheManager(this.config)

    // Validate platform support
    if (!PlatformDetector.isSupported(this.platformInfo)) {
      throw new Error(
        `Platform ${this.platformInfo.platform} is not supported. ` +
          `Supported platforms: linux-arm64, linux-x64, macos-arm64`,
      )
    }

    console.log(`Detected platform: ${this.platformInfo.platform}`)
  }

  /**
   * Download libraries for the current platform with comprehensive error handling
   */
  async downloadLibraries(version?: string): Promise<LibrarySet> {
    const targetVersion = version || this.config.version || 'latest'
    console.log(`Downloading temporal libraries version: ${targetVersion}`)

    try {
      // Check cache first
      const cachedLibraries = await this.getCachedLibraries(targetVersion)
      if (cachedLibraries) {
        console.log(`Found cached libraries for ${targetVersion}, validating compatibility...`)

        const validation = await this.validateLibraryCompatibility(cachedLibraries)
        if (validation.compatible) {
          console.log(`✓ Using cached libraries for ${targetVersion}`)
          return cachedLibraries
        } else {
          console.warn(`⚠️  Cached libraries are incompatible: ${validation.issues.join('; ')}`)
          console.log('Invalidating cache and downloading fresh libraries...')

          // Clear the incompatible cache
          try {
            this.cacheManager.clearCache(targetVersion)
          } catch (error) {
            console.warn(`Failed to clear incompatible cache: ${error instanceof Error ? error.message : error}`)
          }
        }
      }

      // Find the appropriate release
      const release = await this.githubClient.findRelease(targetVersion)
      if (!release) {
        throw new ArtifactNotFoundError(`No release found for version: ${targetVersion}`, targetVersion)
      }

      console.log(`Found release: ${release.name} (${release.tag_name})`)

      // Find platform-specific artifacts
      const { libraryAsset, checksumAsset, availablePlatforms } = this.githubClient.findPlatformArtifacts(
        release,
        this.platformInfo,
      )

      if (!libraryAsset) {
        const platformsText =
          availablePlatforms.length > 0
            ? `Available platforms: ${availablePlatforms.join(', ')}`
            : 'No platform-specific artifacts found in this release'

        throw new ArtifactNotFoundError(
          `No library artifact found for platform ${this.platformInfo.platform} in release ${release.tag_name}. ${platformsText}`,
          targetVersion,
          this.platformInfo.platform,
        )
      }

      console.log(`Found library artifact: ${libraryAsset.name}`)

      if (this.config.checksumVerification && !checksumAsset) {
        console.warn(`⚠️  No checksum file found for ${libraryAsset.name}, proceeding without verification`)
      }

      // Set up download paths
      const downloadDir = this.cacheManager.getDownloadsDir()
      const archivePath = join(downloadDir, libraryAsset.name)
      const checksumPath = checksumAsset ? join(downloadDir, checksumAsset.name) : null

      // Download and verify checksum first if available
      let expectedChecksum: string | null = null
      if (this.config.checksumVerification && checksumAsset) {
        console.log(`Downloading checksum file: ${checksumAsset.name}...`)
        try {
          expectedChecksum = await this.fileDownloader.downloadChecksum(
            checksumAsset.browser_download_url,
            checksumPath as string,
          )
          console.log(`✓ Checksum file downloaded: ${expectedChecksum}`)
        } catch (error) {
          if (this.config.checksumVerification) {
            throw new ChecksumError(
              `Checksum verification is required but checksum file could not be downloaded: ${error instanceof Error ? error.message : error}`,
              undefined,
              undefined,
              error instanceof Error ? error : undefined,
            )
          }
          console.warn(`Failed to download checksum file: ${error instanceof Error ? error.message : error}`)
        }
      }

      // Download the library archive
      console.log(
        `Downloading library archive: ${libraryAsset.name} (${Math.round(libraryAsset.size / 1024 / 1024)}MB)...`,
      )
      await this.fileDownloader.downloadFile(libraryAsset.browser_download_url, archivePath, libraryAsset.size)

      // Verify checksum if available
      if (this.config.checksumVerification && expectedChecksum) {
        console.log(`Verifying archive integrity...`)
        try {
          await this.fileDownloader.verifyChecksum(archivePath, expectedChecksum)
        } catch (error) {
          // Remove corrupted file
          if (existsSync(archivePath)) {
            try {
              rmSync(archivePath)
              console.log('Removed corrupted archive file')
            } catch (cleanupError) {
              console.warn('Could not clean up corrupted file:', cleanupError)
            }
          }
          throw error // Re-throw the ChecksumError
        }
      } else if (this.config.checksumVerification) {
        console.warn('⚠️  Checksum verification is enabled but no checksum available - proceeding without verification')
      }

      // Extract the archive
      const extractDir = this.cacheManager.getCacheDir(release.tag_name, this.platformInfo.platform)
      console.log(`Extracting libraries to ${extractDir}...`)

      try {
        await this.fileDownloader.extractArchive(archivePath, extractDir)
      } catch (error) {
        throw new TemporalLibsError(
          `Failed to extract archive: ${error instanceof Error ? error.message : error}`,
          'EXTRACTION_ERROR',
          error instanceof Error ? error : undefined,
        )
      }

      // Scan extracted files to build LibrarySet
      const libraries = await this.scanExtractedLibraries(extractDir)

      if (libraries.length === 0) {
        throw new TemporalLibsError(
          `No static libraries found in extracted archive for ${this.platformInfo.platform}`,
          'NO_LIBRARIES_FOUND',
        )
      }

      const librarySet: LibrarySet = {
        platform: this.platformInfo.os,
        architecture: this.platformInfo.arch,
        version: release.tag_name,
        libraries,
      }

      // Validate library compatibility
      console.log('Validating library compatibility...')
      const validation = await this.validateLibraryCompatibility(librarySet)

      if (!validation.compatible) {
        throw new TemporalLibsError(
          `Downloaded libraries are not compatible with current platform: ${validation.issues.join('; ')}`,
          'LIBRARY_INCOMPATIBLE',
        )
      }

      // Save to cache
      try {
        await this.cacheManager.saveToCache(librarySet)
      } catch (error) {
        console.warn(`Failed to save libraries to cache: ${error instanceof Error ? error.message : error}`)
        // Don't fail the entire operation if caching fails
      }

      // Clean up old versions (don't fail if this fails)
      try {
        this.cacheManager.cleanupOldVersions(3)
      } catch (error) {
        console.warn(`Failed to cleanup old cache versions: ${error instanceof Error ? error.message : error}`)
      }

      console.log(`✓ Successfully downloaded and extracted ${libraries.length} libraries`)
      return librarySet
    } catch (error) {
      console.error('✗ Failed to download libraries:', error instanceof Error ? error.message : error)

      // Provide detailed error information
      if (error instanceof TemporalLibsError) {
        console.error(`Error code: ${error.code}`)
        if (error.cause) {
          console.error(`Caused by: ${error.cause.message}`)
        }
      }

      // Attempt fallback to Rust compilation if enabled
      if (this.config.fallbackToCompilation) {
        console.log('🔄 Attempting fallback to Rust compilation...')
        return await this.fallbackToRustCompilation(
          targetVersion,
          error instanceof Error ? error : new Error(String(error)),
        )
      }

      // Re-throw the original error with context
      if (error instanceof TemporalLibsError) {
        throw error
      } else {
        throw new TemporalLibsError(
          `Download failed: ${error instanceof Error ? error.message : error}`,
          'DOWNLOAD_FAILED',
          error instanceof Error ? error : undefined,
        )
      }
    }
  }

  /**
   * Fallback to Rust compilation when download fails
   */
  private async fallbackToRustCompilation(_version: string, originalError: Error): Promise<LibrarySet> {
    try {
      console.log('⚠️  Falling back to Rust compilation due to download failure')
      console.log(`Original error: ${originalError.message}`)

      // Check if Rust toolchain is available
      const rustcCheck = Bun.spawn(['rustc', '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const rustcExitCode = await rustcCheck.exited

      if (rustcExitCode !== 0) {
        throw new FallbackError(
          'Rust toolchain not available for fallback compilation. Please install Rust or fix the download issue.',
          originalError,
        )
      }

      const rustcOutput = await new Response(rustcCheck.stdout).text()
      console.log(`Found Rust toolchain: ${rustcOutput.trim()}`)

      // Check if cargo is available
      const cargoCheck = Bun.spawn(['cargo', '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const cargoExitCode = await cargoCheck.exited

      if (cargoExitCode !== 0) {
        throw new FallbackError(
          'Cargo not available for fallback compilation. Please install Cargo or fix the download issue.',
          originalError,
        )
      }

      const cargoOutput = await new Response(cargoCheck.stdout).text()
      console.log(`Found Cargo: ${cargoOutput.trim()}`)

      // Check if vendor directory exists
      const vendorPath = join(process.cwd(), 'packages/temporal-bun-sdk/vendor/sdk-core')
      if (!existsSync(vendorPath)) {
        throw new FallbackError(
          'Vendor directory not found for Rust compilation fallback. Run "git submodule update --init --recursive" to set up the vendor directory.',
          originalError,
        )
      }

      const cargoTomlPath = join(vendorPath, 'Cargo.toml')
      if (!existsSync(cargoTomlPath)) {
        throw new FallbackError(
          'Cargo.toml not found in vendor directory. The vendor directory may be incomplete.',
          originalError,
        )
      }

      console.log('✓ Found vendor directory with Cargo.toml')

      // Determine target triple for cross-compilation
      const targetTriple = this.getCargoTargetTriple()
      console.log(`Building for target: ${targetTriple}`)

      // Build with cargo
      console.log('🔨 Starting Rust compilation (this may take several minutes)...')
      const buildStartTime = Date.now()

      const cargoArgs = ['build', '--release', '--target', targetTriple]
      const cargoBuild = Bun.spawn(cargoArgs, {
        cwd: vendorPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Add cross-compilation environment variables if needed
          ...this.getCrossCompilationEnv(),
        },
      })

      // Monitor build progress
      let buildOutput = ''
      let buildErrors = ''

      if (cargoBuild.stdout) {
        const reader = cargoBuild.stdout.getReader()
        const decoder = new TextDecoder()

        const readOutput = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              const text = decoder.decode(value)
              buildOutput += text
              process.stdout.write(text) // Show build progress
            }
          } finally {
            reader.releaseLock()
          }
        }

        readOutput().catch(console.warn)
      }

      if (cargoBuild.stderr) {
        const stderrText = await new Response(cargoBuild.stderr).text()
        buildErrors = stderrText
        if (stderrText.trim()) {
          console.error('Build warnings/errors:', stderrText)
        }
      }

      const buildExitCode = await cargoBuild.exited
      const buildDuration = Math.round((Date.now() - buildStartTime) / 1000)

      if (buildExitCode !== 0) {
        throw new FallbackError(
          `Cargo build failed with exit code ${buildExitCode}. Build output: ${buildErrors || buildOutput}`,
          originalError,
        )
      }

      console.log(`✓ Rust compilation completed in ${buildDuration}s`)

      // Scan for built libraries
      const targetDir = join(vendorPath, 'target', targetTriple, 'release')
      const libraries = await this.scanCargoBuiltLibraries(targetDir)

      if (libraries.length === 0) {
        throw new FallbackError(
          `No static libraries found in cargo build output directory: ${targetDir}`,
          originalError,
        )
      }

      console.log(`✓ Found ${libraries.length} compiled libraries`)

      // Create LibrarySet from cargo-built libraries
      const librarySet: LibrarySet = {
        platform: this.platformInfo.os,
        architecture: this.platformInfo.arch,
        version: `cargo-built-${Date.now()}`, // Use timestamp for cargo builds
        libraries,
      }

      // Optionally cache the cargo-built libraries
      try {
        await this.cacheManager.saveToCache(librarySet)
        console.log('✓ Cached cargo-built libraries for future use')
      } catch (cacheError) {
        console.warn(
          `Failed to cache cargo-built libraries: ${cacheError instanceof Error ? cacheError.message : cacheError}`,
        )
      }

      return librarySet
    } catch (error) {
      if (error instanceof FallbackError) {
        throw error
      }

      throw new FallbackError(
        `Fallback to Rust compilation failed: ${error instanceof Error ? error.message : error}`,
        originalError,
        error instanceof Error ? error : undefined,
      )
    }
  }

  /**
   * Get cargo target triple for current platform
   */
  private getCargoTargetTriple(): string {
    switch (this.platformInfo.os) {
      case 'macos':
        return this.platformInfo.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
      case 'linux':
        return this.platformInfo.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
      case 'windows':
        return this.platformInfo.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
      default:
        throw new Error(`Unsupported platform for cargo build: ${this.platformInfo.platform}`)
    }
  }

  /**
   * Get cross-compilation environment variables
   */
  private getCrossCompilationEnv(): Record<string, string> {
    const env: Record<string, string> = {}

    // Add cross-compilation environment variables for ARM64 Linux
    if (this.platformInfo.os === 'linux' && this.platformInfo.arch === 'arm64') {
      env.CC = 'aarch64-linux-gnu-gcc'
      env.CXX = 'aarch64-linux-gnu-g++'
      env.AR = 'aarch64-linux-gnu-ar'
      env.STRIP = 'aarch64-linux-gnu-strip'
      env.PKG_CONFIG_PATH = '/usr/lib/aarch64-linux-gnu/pkgconfig'
    }

    return env
  }

  /**
   * Scan cargo build output directory for static libraries
   */
  private async scanCargoBuiltLibraries(targetDir: string): Promise<StaticLibrary[]> {
    const libraries: StaticLibrary[] = []

    if (!existsSync(targetDir)) {
      throw new Error(`Cargo build target directory not found: ${targetDir}`)
    }

    console.log(`Scanning for static libraries in ${targetDir}...`)

    try {
      // Use find command to locate all .a files
      const proc = Bun.spawn(['find', targetDir, '-name', '*.a', '-type', 'f'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`Failed to scan cargo build directory: ${stderr}`)
      }

      const stdout = await new Response(proc.stdout).text()
      const libraryPaths = stdout
        .trim()
        .split('\n')
        .filter((path) => path.length > 0)

      if (libraryPaths.length === 0) {
        console.warn(`⚠️  No static libraries (.a files) found in ${targetDir}`)
        return libraries
      }

      console.log(`Found ${libraryPaths.length} static libraries, calculating checksums...`)

      // Process each library file
      for (let i = 0; i < libraryPaths.length; i++) {
        const libPath = libraryPaths[i]
        const libName = libPath.split('/').pop() || ''

        try {
          // Verify file exists and is readable
          const stats = statSync(libPath)
          if (stats.size === 0) {
            console.warn(`⚠️  Skipping empty library file: ${libName}`)
            continue
          }

          process.stdout.write(`\rProcessing library ${i + 1}/${libraryPaths.length}: ${libName}`)

          const checksum = await this.fileDownloader.calculateChecksum(libPath)

          libraries.push({
            name: libName,
            path: libPath,
            checksum,
          })
        } catch (error) {
          console.warn(`\n⚠️  Error processing library ${libName}: ${error}`)
          continue
        }
      }

      console.log(`\n✓ Successfully processed ${libraries.length} static libraries`)

      // Log library details
      for (const lib of libraries) {
        const stats = statSync(lib.path)
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        console.log(`  ${lib.name}: ${sizeMB}MB (${lib.checksum.substring(0, 8)}...)`)
      }
    } catch (error) {
      throw new Error(`Failed to scan cargo-built libraries: ${error instanceof Error ? error.message : error}`)
    }

    return libraries
  }

  /**
   * Scan extracted directory for library files
   */
  private async scanExtractedLibraries(extractDir: string): Promise<StaticLibrary[]> {
    const libraries: StaticLibrary[] = []

    if (!existsSync(extractDir)) {
      throw new Error(`Extract directory not found: ${extractDir}`)
    }

    console.log(`Scanning for static libraries in ${extractDir}...`)

    try {
      // Use find command to locate all .a files (static libraries)
      const proc = Bun.spawn(['find', extractDir, '-name', '*.a', '-type', 'f'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`Failed to scan directory: ${stderr}`)
      }

      const stdout = await new Response(proc.stdout).text()
      const libraryPaths = stdout
        .trim()
        .split('\n')
        .filter((path) => path.length > 0)

      if (libraryPaths.length === 0) {
        console.warn(`⚠️  No static libraries (.a files) found in ${extractDir}`)

        // List what was actually extracted for debugging
        try {
          const entries = readdirSync(extractDir, { recursive: true })
          console.log(`Found ${entries.length} extracted files/directories:`)
          for (const entry of entries.slice(0, 10)) {
            console.log(`  ${entry}`)
          }
          if (entries.length > 10) {
            console.log(`  ... and ${entries.length - 10} more`)
          }
        } catch (listError) {
          console.warn('Could not list extracted contents:', listError)
        }

        return libraries
      }

      console.log(`Found ${libraryPaths.length} static libraries, calculating checksums...`)

      // Process each library file
      for (let i = 0; i < libraryPaths.length; i++) {
        const libPath = libraryPaths[i]
        const libName = libPath.split('/').pop() || ''

        try {
          // Verify file exists and is readable
          const stats = statSync(libPath)
          if (stats.size === 0) {
            console.warn(`⚠️  Skipping empty library file: ${libName}`)
            continue
          }

          process.stdout.write(`\rProcessing library ${i + 1}/${libraryPaths.length}: ${libName}`)

          const checksum = await this.fileDownloader.calculateChecksum(libPath)

          libraries.push({
            name: libName,
            path: libPath,
            checksum,
          })
        } catch (error) {
          console.warn(`\n⚠️  Error processing library ${libName}: ${error}`)
          continue
        }
      }

      console.log(`\n✓ Successfully processed ${libraries.length} static libraries`)

      // Log library details
      for (const lib of libraries) {
        const stats = statSync(lib.path)
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
        console.log(`  ${lib.name}: ${sizeMB}MB (${lib.checksum.substring(0, 8)}...)`)
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to scan extracted libraries: ${error.message}`)
      } else {
        throw new Error(`Failed to scan extracted libraries: ${error}`)
      }
    }

    return libraries
  }

  /**
   * Get platform information
   */
  getPlatformInfo(): PlatformInfo {
    return this.platformInfo
  }

  /**
   * Get configuration
   */
  getConfig(): TemporalLibsConfig {
    return { ...this.config }
  }

  /**
   * Get cached libraries for a specific version
   */
  async getCachedLibraries(version: string): Promise<LibrarySet | null> {
    return await this.cacheManager.getCachedLibraries(version, this.platformInfo.platform)
  }

  /**
   * Clear cache for specific version or all versions
   */
  clearCache(version?: string): void {
    this.cacheManager.clearCache(version, this.platformInfo.platform)
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cacheManager.getCacheStats()
  }

  /**
   * Clean up old cached versions
   */
  cleanupOldVersions(keepCount: number = 3): void {
    this.cacheManager.cleanupOldVersions(keepCount)
  }

  /**
   * Get cache manager instance for advanced operations
   */
  getCacheManager(): CacheManager {
    return this.cacheManager
  }

  /**
   * Validate library compatibility with current platform and architecture
   */
  async validateLibraryCompatibility(librarySet: LibrarySet): Promise<{
    compatible: boolean
    issues: string[]
    warnings: string[]
  }> {
    const issues: string[] = []
    const warnings: string[] = []

    try {
      // Check platform compatibility
      if (librarySet.platform !== this.platformInfo.os) {
        issues.push(
          `Platform mismatch: library is for ${librarySet.platform}, but current platform is ${this.platformInfo.os}`,
        )
      }

      if (librarySet.architecture !== this.platformInfo.arch) {
        issues.push(
          `Architecture mismatch: library is for ${librarySet.architecture}, but current architecture is ${this.platformInfo.arch}`,
        )
      }

      // Check if all expected libraries are present
      const expectedLibraries = [
        'libtemporal_sdk_core.a',
        'libtemporal_sdk_core_c_bridge.a',
        'libtemporal_client.a',
        'libtemporal_sdk_core_api.a',
        'libtemporal_sdk_core_protos.a',
      ]

      const presentLibraries = librarySet.libraries.map((lib) => lib.name)
      const missingLibraries = expectedLibraries.filter(
        (expected) => !presentLibraries.some((present) => present === expected),
      )

      if (missingLibraries.length > 0) {
        issues.push(`Missing expected libraries: ${missingLibraries.join(', ')}`)
      }

      // Check if library files actually exist and are readable
      for (const library of librarySet.libraries) {
        if (!existsSync(library.path)) {
          issues.push(`Library file not found: ${library.path}`)
          continue
        }

        try {
          const stats = statSync(library.path)
          if (stats.size === 0) {
            issues.push(`Library file is empty: ${library.name}`)
          } else if (stats.size < 1024) {
            warnings.push(`Library file is very small (${stats.size} bytes): ${library.name}`)
          }

          // Try to read a small portion to verify it's accessible
          readFileSync(library.path, { encoding: null, flag: 'r' })
        } catch (error) {
          issues.push(`Cannot read library file ${library.name}: ${error instanceof Error ? error.message : error}`)
        }
      }

      // Validate library format using file command if available
      try {
        for (const library of librarySet.libraries.slice(0, 3)) {
          // Check first 3 libraries
          if (!existsSync(library.path)) continue

          const fileCheck = Bun.spawn(['file', library.path], {
            stdio: ['ignore', 'pipe', 'pipe'],
          })

          const exitCode = await fileCheck.exited
          if (exitCode === 0) {
            const output = await new Response(fileCheck.stdout).text()

            // Check if it's actually a static library
            if (!output.includes('ar archive') && !output.includes('current ar archive')) {
              warnings.push(`Library ${library.name} may not be a valid static library: ${output.trim()}`)
            }

            // Check architecture compatibility
            const currentArch = this.platformInfo.arch
            if (currentArch === 'arm64' && output.includes('x86-64')) {
              issues.push(`Architecture mismatch in ${library.name}: library is x86-64 but current platform is ARM64`)
            } else if (currentArch === 'x64' && output.includes('arm64')) {
              issues.push(`Architecture mismatch in ${library.name}: library is ARM64 but current platform is x86-64`)
            }
          }
        }
      } catch (error) {
        warnings.push(
          `Could not validate library format using 'file' command: ${error instanceof Error ? error.message : error}`,
        )
      }

      const compatible = issues.length === 0

      if (!compatible) {
        console.error('✗ Library compatibility validation failed:')
        for (const issue of issues) {
          console.error(`  - ${issue}`)
        }
      }

      if (warnings.length > 0) {
        console.warn('⚠️  Library compatibility warnings:')
        for (const warning of warnings) {
          console.warn(`  - ${warning}`)
        }
      }

      if (compatible && warnings.length === 0) {
        console.log('✓ Library compatibility validation passed')
      }

      return { compatible, issues, warnings }
    } catch (error) {
      const errorMessage = `Library compatibility validation error: ${error instanceof Error ? error.message : error}`
      issues.push(errorMessage)
      console.error(`✗ ${errorMessage}`)

      return { compatible: false, issues, warnings }
    }
  }

  /**
   * Provide troubleshooting guidance based on error type
   */
  static provideTroubleshootingGuidance(error: Error): void {
    console.log('\n🔧 Troubleshooting Guide:')

    if (error instanceof ArtifactNotFoundError) {
      console.log('   Problem: Required artifacts not found')
      console.log('   Solutions:')
      console.log('   1. Check if the specified version exists:')
      console.log('      bun run download-temporal-libs.ts cache-stats')
      console.log('   2. Try using the latest version:')
      console.log('      bun run download-temporal-libs.ts download latest')
      console.log('   3. Check available releases on GitHub')

      if (error.platform) {
        console.log(`   4. Your platform (${error.platform}) may not be supported`)
        console.log('      Supported platforms: linux-arm64, linux-x64, macos-arm64')
      }
    } else if (error instanceof NetworkError) {
      console.log('   Problem: Network connectivity issues')
      console.log('   Solutions:')
      console.log('   1. Check your internet connection')
      console.log('   2. Try again later (temporary server issues)')
      console.log("   3. Check if you're behind a corporate firewall")
      console.log('   4. Use a VPN if GitHub is blocked in your region')
    } else if (error instanceof RateLimitError) {
      console.log('   Problem: GitHub API rate limit exceeded')
      console.log('   Solutions:')
      console.log('   1. Wait for the rate limit to reset')
      console.log('   2. Use cached libraries if available')
      console.log('   3. Set up GitHub authentication to increase rate limits')
    } else if (error instanceof ChecksumError) {
      console.log('   Problem: Downloaded file integrity check failed')
      console.log('   Solutions:')
      console.log('   1. Clear cache and try downloading again:')
      console.log('      bun run download-temporal-libs.ts cache-clear')
      console.log('   2. Check your network connection stability')
      console.log('   3. Try downloading a different version')
    } else if (error instanceof PlatformError) {
      console.log('   Problem: Platform compatibility issues')
      console.log('   Solutions:')
      console.log('   1. Check supported platforms: linux-arm64, linux-x64, macos-arm64')
      console.log('   2. Use cross-compilation if building for a different target')
      console.log('   3. Set up vendor directory for Rust compilation fallback')
    } else if (error instanceof FallbackError) {
      console.log('   Problem: Fallback to Rust compilation failed')
      console.log('   Solutions:')
      console.log('   1. Install Rust toolchain: https://rustup.rs/')
      console.log('   2. Set up vendor directory:')
      console.log('      git submodule update --init --recursive')
      console.log('   3. Install cross-compilation tools if needed')
      console.log('   4. Fix the original download issue instead')
    } else if (error instanceof CacheError) {
      console.log('   Problem: Cache management issues')
      console.log('   Solutions:')
      console.log('   1. Clear the cache:')
      console.log('      bun run download-temporal-libs.ts cache-clear')
      console.log('   2. Validate and repair cache:')
      console.log('      bun run download-temporal-libs.ts cache-validate')
      console.log('   3. Check disk space and permissions')
    } else {
      console.log('   Problem: General error occurred')
      console.log('   Solutions:')
      console.log('   1. Check the error message above for specific details')
      console.log('   2. Try clearing cache and downloading again')
      console.log('   3. Check system requirements and dependencies')
      console.log('   4. Report the issue if it persists')
    }

    console.log('\n   For more help:')
    console.log('   - Check the project documentation')
    console.log('   - Run with verbose logging for more details')
    console.log('   - Report issues on the project repository\n')
  }
}

// CLI interface when run directly
if (import.meta.main) {
  const args = process.argv.slice(2)
  const command = args[0] || 'download'

  try {
    // Handle target platform override before creating client
    const targetPlatform = command === 'download' ? args[2] : undefined
    if (targetPlatform) {
      const [os, arch] = targetPlatform.split('-')
      if (os && arch) {
        process.env.FORCE_PLATFORM = os === 'macos' ? 'darwin' : os
        process.env.FORCE_ARCH = arch
        console.log(`Downloading for target platform: ${targetPlatform}`)
      } else {
        console.error(
          `Invalid target platform format: ${targetPlatform}. Expected format: os-arch (e.g., linux-x64, darwin-arm64)`,
        )
        process.exit(1)
      }
    }

    const client = new DownloadClient()

    switch (command) {
      case 'download': {
        const version = args[1] || 'latest'
        console.log('Platform info:', client.getPlatformInfo())
        console.log(`Downloading temporal libraries version: ${version}...`)
        await client.downloadLibraries(version)
        break
      }

      case 'cache-stats': {
        console.log('Cache Statistics:')
        const stats = client.getCacheStats()
        console.log(`Total cache size: ${Math.round(stats.totalSize / 1024 / 1024)}MB`)
        console.log(`Cached versions: ${stats.versionCount}`)

        if (stats.versions.length > 0) {
          console.log('\nCached versions:')
          for (const version of stats.versions) {
            const sizeMB = Math.round(version.size / 1024 / 1024)
            console.log(`  ${version.version}: ${version.platforms.join(', ')} (${sizeMB}MB)`)
            if (version.cachedAt) {
              console.log(`    Cached: ${new Date(version.cachedAt).toLocaleString()}`)
            }
          }
        }
        break
      }

      case 'cache-clear': {
        const version = args[1]
        if (version) {
          console.log(`Clearing cache for version: ${version}`)
          client.clearCache(version)
        } else {
          console.log('Clearing entire cache...')
          client.clearCache()
        }
        console.log('✓ Cache cleared')
        break
      }

      case 'cache-cleanup': {
        const keepCount = args[1] ? parseInt(args[1]) : 3
        console.log(`Cleaning up old versions, keeping ${keepCount} most recent...`)
        client.cleanupOldVersions(keepCount)
        break
      }

      case 'cache-validate': {
        console.log('Validating and repairing cache...')
        const result = await client.getCacheManager().validateAndRepairCache()

        console.log('\nValidation Summary:')
        console.log(`  Valid entries: ${result.valid}`)
        console.log(`  Repaired entries: ${result.repaired}`)
        console.log(`  Removed entries: ${result.removed}`)

        if (result.errors.length > 0) {
          console.log(`  Errors: ${result.errors.length}`)
          for (const error of result.errors) {
            console.log(`    - ${error}`)
          }
        }

        if (result.errors.length === 0) {
          console.log('✓ Cache validation completed successfully')
        } else {
          console.log('⚠️  Cache validation completed with errors')
        }
        break
      }

      case 'help':
      default: {
        console.log('Temporal Libraries Download Client')
        console.log('')
        console.log('Usage:')
        console.log('  bun run download-temporal-libs.ts [command] [options]')
        console.log('')
        console.log('Commands:')
        console.log('  download [version] [platform]  Download libraries (default: latest, host platform)')
        console.log('  cache-stats                    Show cache statistics')
        console.log('  cache-clear [version]          Clear cache (all or specific version)')
        console.log('  cache-cleanup [keep]           Clean up old versions (default: keep 3)')
        console.log('  cache-validate                 Validate and repair cache integrity')
        console.log('  help                           Show this help message')
        console.log('')
        console.log('Examples:')
        console.log('  bun run download-temporal-libs.ts download latest')
        console.log('  bun run download-temporal-libs.ts download latest macos-arm64')
        console.log('  bun run download-temporal-libs.ts download latest linux-x64')
        console.log('  bun run download-temporal-libs.ts cache-stats')
        console.log('  bun run download-temporal-libs.ts cache-clear v1.0.0')
        console.log('  bun run download-temporal-libs.ts cache-cleanup 5')
        console.log('  bun run download-temporal-libs.ts cache-validate')
        break
      }
    }
  } catch (error) {
    console.error('✗ Error:', error instanceof Error ? error.message : error)

    if (error instanceof Error) {
      DownloadClient.provideTroubleshootingGuidance(error)
    }

    process.exit(1)
  }
}
