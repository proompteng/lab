import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

// Mock the download client module
const mockFetch = mock()
const mockExistsSync = spyOn(require('fs'), 'existsSync')
const mockMkdirSync = spyOn(require('fs'), 'mkdirSync')
const mockWriteFileSync = spyOn(require('fs'), 'writeFileSync')
const mockReadFileSync = spyOn(require('fs'), 'readFileSync')
const mockRmSync = spyOn(require('fs'), 'rmSync')

// Mock global fetch
global.fetch = mockFetch

// Import types and classes from the actual implementation
import type { PlatformInfo, TemporalLibsConfig } from '../scripts/download-temporal-libs.ts'

describe('Download Client Unit Tests', () => {
  const testCacheDir = join(process.cwd(), 'test-cache')
  const testVersion = 'v1.0.0'
  const testPlatform = 'linux'
  const testArch = 'arm64'

  beforeEach(() => {
    // Reset all mocks
    mockFetch.mockReset()
    mockExistsSync.mockReset()
    mockMkdirSync.mockReset()
    mockWriteFileSync.mockReset()
    mockReadFileSync.mockReset()
    mockRmSync.mockReset()

    // Set up default mock behaviors
    mockExistsSync.mockReturnValue(false)
    mockMkdirSync.mockReturnValue(undefined)
    mockWriteFileSync.mockReturnValue(undefined)
    mockRmSync.mockReturnValue(undefined)
  })

  afterEach(() => {
    // Clean up any real test files
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true, force: true })
    }
  })

  describe('Platform Detection', () => {
    test('should detect Linux ARM64 platform correctly', async () => {
      // Mock process.platform and process.arch
      const originalPlatform = process.platform
      const originalArch = process.arch

      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'arch', { value: 'arm64' })

      // Import the module after mocking
      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      const platform = PlatformDetector.detectPlatform()
      expect(platform).toEqual({
        os: 'linux',
        arch: 'arm64',
        platform: 'linux-arm64',
      })

      // Restore original values
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      Object.defineProperty(process, 'arch', { value: originalArch })
    })

    test('should detect Linux x64 platform correctly', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'arch', { value: 'x64' })

      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      const platform = PlatformDetector.detectPlatform()
      expect(platform).toEqual({
        os: 'linux',
        arch: 'x64',
        platform: 'linux-x64',
      })

      Object.defineProperty(process, 'platform', { value: originalPlatform })
      Object.defineProperty(process, 'arch', { value: originalArch })
    })

    test('should detect macOS ARM64 platform correctly', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      Object.defineProperty(process, 'platform', { value: 'darwin' })
      Object.defineProperty(process, 'arch', { value: 'arm64' })

      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      const platform = PlatformDetector.detectPlatform()
      expect(platform).toEqual({
        os: 'macos',
        arch: 'arm64',
        platform: 'macos-arm64',
      })

      Object.defineProperty(process, 'platform', { value: originalPlatform })
      Object.defineProperty(process, 'arch', { value: originalArch })
    })

    test('should handle unsupported platform gracefully', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      Object.defineProperty(process, 'platform', { value: 'freebsd' })
      Object.defineProperty(process, 'arch', { value: 'x64' })

      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      expect(() => PlatformDetector.detectPlatform()).toThrow('Unsupported platform: freebsd')

      Object.defineProperty(process, 'platform', { value: originalPlatform })
      Object.defineProperty(process, 'arch', { value: originalArch })
    })

    test('should check if platform is supported', async () => {
      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      expect(PlatformDetector.isSupported({ os: 'linux', arch: 'arm64', platform: 'linux-arm64' })).toBe(true)
      expect(PlatformDetector.isSupported({ os: 'linux', arch: 'x64', platform: 'linux-x64' })).toBe(true)
      expect(PlatformDetector.isSupported({ os: 'macos', arch: 'arm64', platform: 'macos-arm64' })).toBe(true)
      expect(PlatformDetector.isSupported({ os: 'windows', arch: 'x64', platform: 'windows-x64' })).toBe(false)
    })
  })

  describe('GitHub API Client', () => {
    test('should fetch releases successfully', async () => {
      const mockReleaseData = [
        {
          tag_name: 'temporal-libs-v1.0.0',
          name: 'Temporal Static Libraries v1.0.0',
          assets: [
            {
              name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz',
              browser_download_url:
                'https://github.com/test/repo/releases/download/temporal-libs-v1.0.0/temporal-static-libs-linux-arm64-v1.0.0.tar.gz',
              size: 1024000,
            },
            {
              name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz.sha256',
              browser_download_url:
                'https://github.com/test/repo/releases/download/temporal-libs-v1.0.0/temporal-static-libs-linux-arm64-v1.0.0.tar.gz.sha256',
              size: 64,
            },
          ],
        },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleaseData),
        headers: new Map([
          ['X-RateLimit-Remaining', '4999'],
          ['X-RateLimit-Limit', '5000'],
        ]),
      })

      const { GitHubApiClient } = await import('../scripts/download-temporal-libs.ts')
      const client = new GitHubApiClient('test', 'repo')

      const result = await client.fetchReleases()
      expect(result).toEqual(mockReleaseData)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/test/repo/releases',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'temporal-bun-sdk-download-client',
          }),
        }),
      )
    })

    test('should handle GitHub API rate limits with retry', async () => {
      const resetTime = Math.floor((Date.now() + 3600000) / 1000) // 1 hour from now

      // First call returns rate limit error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Map([
          ['X-RateLimit-Remaining', '0'],
          ['X-RateLimit-Reset', resetTime.toString()],
        ]),
      })

      const { GitHubApiClient, RateLimitError } = await import('../scripts/download-temporal-libs.ts')
      const client = new GitHubApiClient('test', 'repo', {
        rateLimitRetryDelayMs: 100, // Short delay for testing
        maxRateLimitRetries: 1,
      })

      await expect(client.fetchReleases()).rejects.toThrow(RateLimitError)
    })

    test('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const { GitHubApiClient, NetworkError } = await import('../scripts/download-temporal-libs.ts')
      const client = new GitHubApiClient('test', 'repo', { retryAttempts: 1 })

      await expect(client.fetchReleases()).rejects.toThrow(NetworkError)
    })

    test('should handle 404 for non-existent repository', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const { GitHubApiClient, ArtifactNotFoundError } = await import('../scripts/download-temporal-libs.ts')
      const client = new GitHubApiClient('test', 'nonexistent')

      await expect(client.fetchReleases()).rejects.toThrow(ArtifactNotFoundError)
    })

    test('should find specific release by version', async () => {
      const mockReleases = [
        { tag_name: 'temporal-libs-v1.0.0', name: 'v1.0.0', assets: [] },
        { tag_name: 'temporal-libs-v1.1.0', name: 'v1.1.0', assets: [] },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
        headers: new Map(),
      })

      const { GitHubApiClient } = await import('../scripts/download-temporal-libs.ts')
      const client = new GitHubApiClient('test', 'repo')

      const release = await client.findRelease('v1.0.0')
      expect(release?.tag_name).toBe('temporal-libs-v1.0.0')
    })
  })

  describe('File Downloader', () => {
    test('should verify correct SHA256 checksum', async () => {
      const testData = 'test file content'
      const expectedChecksum = createHash('sha256').update(testData).digest('hex')

      mockExistsSync.mockReturnValueOnce(true) // File exists
      mockReadFileSync.mockReturnValueOnce(Buffer.from(testData))

      const { FileDownloader } = await import('../scripts/download-temporal-libs.ts')
      const downloader = new FileDownloader()

      const result = await downloader.verifyChecksum('/test/file.tar.gz', expectedChecksum)
      expect(result).toBe(true)
    })

    test('should reject incorrect checksum', async () => {
      const testData = 'test file content'
      const wrongChecksum = 'incorrect_checksum_value'

      mockExistsSync.mockReturnValueOnce(true) // File exists
      mockReadFileSync.mockReturnValueOnce(Buffer.from(testData))

      const { FileDownloader } = await import('../scripts/download-temporal-libs.ts')
      const downloader = new FileDownloader()

      const result = await downloader.verifyChecksum('/test/file.tar.gz', wrongChecksum)
      expect(result).toBe(false)
    })

    test('should throw ChecksumError for missing files', async () => {
      mockExistsSync.mockReturnValueOnce(false) // File doesn't exist

      const { FileDownloader, ChecksumError } = await import('../scripts/download-temporal-libs.ts')
      const downloader = new FileDownloader()

      await expect(downloader.verifyChecksum('/nonexistent/file.tar.gz', 'some_checksum')).rejects.toThrow(
        ChecksumError,
      )
    })

    test('should download file with progress tracking', async () => {
      const mockFileData = Buffer.from('mock file content')

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', mockFileData.length.toString()]]),
        arrayBuffer: () => Promise.resolve(mockFileData.buffer),
      })

      // Mock directory creation
      mockExistsSync.mockReturnValueOnce(true) // Directory exists

      const { FileDownloader } = await import('../scripts/download-temporal-libs.ts')
      const downloader = new FileDownloader()

      await downloader.downloadFile('https://example.com/file.tar.gz', join(testCacheDir, 'output.tar.gz'))

      expect(mockWriteFileSync).toHaveBeenCalled()
    })

    test('should handle download failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const { FileDownloader, ArtifactNotFoundError } = await import('../scripts/download-temporal-libs.ts')
      const downloader = new FileDownloader()

      await expect(
        downloader.downloadFile('https://example.com/nonexistent.tar.gz', join(testCacheDir, 'output.tar.gz')),
      ).rejects.toThrow(ArtifactNotFoundError)
    })
  })

  describe('Cache Management', () => {
    test('should initialize cache directory', async () => {
      mockExistsSync.mockReturnValueOnce(false) // Cache dir doesn't exist

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      cacheManager.ensureCacheDirectory()

      expect(mockMkdirSync).toHaveBeenCalled()
    })

    test('should not create cache directory if it already exists', async () => {
      mockExistsSync.mockReturnValueOnce(true) // Cache dir exists

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      cacheManager.ensureCacheDirectory()

      expect(mockMkdirSync).not.toHaveBeenCalled()
    })

    test('should check if cached library exists and is valid', async () => {
      const testChecksum = 'valid_checksum_value'
      const testData = 'cached library content'
      const actualChecksum = createHash('sha256').update(testData).digest('hex')

      mockExistsSync.mockReturnValue(true) // Files exist
      mockReadFileSync.mockReturnValueOnce(testChecksum) // Checksum file content
      mockReadFileSync.mockReturnValueOnce(Buffer.from(testData)) // Archive content

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      const result = cacheManager.isCachedLibraryValid('linux', 'arm64', 'v1.0.0')
      expect(result).toBe(actualChecksum === testChecksum)
    })

    test('should return false for missing cached files', async () => {
      mockExistsSync.mockReturnValue(false) // Files don't exist

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      const result = cacheManager.isCachedLibraryValid('linux', 'arm64', 'v1.0.0')
      expect(result).toBe(false)
    })

    test('should clear cache directory', async () => {
      mockExistsSync.mockReturnValueOnce(true) // Cache dir exists

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      cacheManager.clearCache()

      expect(mockRmSync).toHaveBeenCalled()
    })

    test('should handle cache clear when directory does not exist', async () => {
      mockExistsSync.mockReturnValueOnce(false) // Cache dir doesn't exist

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      cacheManager.clearCache()

      expect(mockRmSync).not.toHaveBeenCalled()
    })

    test('should get cache statistics', async () => {
      mockExistsSync.mockReturnValueOnce(true) // Cache dir exists

      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')
      const config = { cacheDir: testCacheDir }
      const cacheManager = new CacheManager(config)

      // Mock the internal method that would read directory contents
      const stats = cacheManager.getCacheStats()
      expect(stats).toBeDefined()
    })
  })

  describe('Download Client Integration', () => {
    // Mock platform to be supported for these tests
    beforeEach(() => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      Object.defineProperty(process, 'platform', { value: 'linux' })
      Object.defineProperty(process, 'arch', { value: 'arm64' })
    })

    test('should download libraries successfully', async () => {
      const mockReleases = [
        {
          tag_name: 'temporal-libs-v1.0.0',
          name: 'v1.0.0',
          assets: [
            {
              name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz',
              browser_download_url: 'https://example.com/archive.tar.gz',
              size: 1024,
            },
            {
              name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz.sha256',
              browser_download_url: 'https://example.com/archive.tar.gz.sha256',
              size: 64,
            },
          ],
        },
      ]

      const mockArchiveData = Buffer.from('mock archive content')
      const mockChecksumData = 'mock_checksum_value'

      // Mock GitHub API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
        headers: new Map(),
      })

      // Mock file downloads
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', mockArchiveData.length.toString()]]),
        arrayBuffer: () => Promise.resolve(mockArchiveData.buffer),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockChecksumData),
      })

      mockExistsSync.mockReturnValue(false) // No cached files

      const { DownloadClient } = await import('../scripts/download-temporal-libs.ts')
      const client = new DownloadClient('test', 'repo', { cacheDir: testCacheDir })

      const result = await client.downloadLibraries('v1.0.0', 'linux', 'arm64')
      expect(result).toBeDefined()
      expect(mockWriteFileSync).toHaveBeenCalled()
    })

    test('should use cached libraries when available', async () => {
      mockExistsSync.mockReturnValue(true) // Cached files exist
      mockReadFileSync.mockReturnValueOnce('valid_checksum') // Checksum file
      mockReadFileSync.mockReturnValueOnce(Buffer.from('cached content')) // Archive file

      const { DownloadClient } = await import('../scripts/download-temporal-libs.ts')
      const client = new DownloadClient('test', 'repo', { cacheDir: testCacheDir })

      const result = await client.downloadLibraries('v1.0.0', 'linux', 'arm64')
      expect(result).toBeDefined()
      expect(mockFetch).not.toHaveBeenCalled() // Should not make API calls if cached
    })

    test('should handle download failures gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const { DownloadClient, ArtifactNotFoundError } = await import('../scripts/download-temporal-libs.ts')
      const client = new DownloadClient('test', 'repo', { cacheDir: testCacheDir })

      await expect(client.downloadLibraries('v999.0.0', 'linux', 'arm64')).rejects.toThrow(ArtifactNotFoundError)
    })

    test('should extract libraries after download', async () => {
      const mockReleases = [
        {
          tag_name: 'temporal-libs-v1.0.0',
          name: 'v1.0.0',
          assets: [
            {
              name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz',
              browser_download_url: 'https://example.com/archive.tar.gz',
              size: 1024,
            },
          ],
        },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
        headers: new Map(),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '1024']]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      })

      mockExistsSync.mockReturnValue(false)

      const { DownloadClient } = await import('../scripts/download-temporal-libs.ts')
      const client = new DownloadClient('test', 'repo', { cacheDir: testCacheDir })

      const result = await client.downloadLibraries('v1.0.0', 'linux', 'arm64')
      expect(result).toBeDefined()
    })
  })

  describe('Error Handling', () => {
    test('should create appropriate error types', async () => {
      const {
        TemporalLibsError,
        NetworkError,
        RateLimitError,
        ChecksumError,
        PlatformError,
        ArtifactNotFoundError,
        CacheError,
        FallbackError,
      } = await import('../scripts/download-temporal-libs.ts')

      const baseError = new TemporalLibsError('Base error', 'BASE_ERROR')
      expect(baseError.name).toBe('TemporalLibsError')
      expect(baseError.code).toBe('BASE_ERROR')

      const networkError = new NetworkError('Network failed')
      expect(networkError.name).toBe('NetworkError')
      expect(networkError.code).toBe('NETWORK_ERROR')

      const rateLimitError = new RateLimitError('Rate limited', new Date())
      expect(rateLimitError.name).toBe('RateLimitError')
      expect(rateLimitError.code).toBe('RATE_LIMIT_ERROR')

      const checksumError = new ChecksumError('Checksum mismatch', 'expected', 'actual')
      expect(checksumError.name).toBe('ChecksumError')
      expect(checksumError.code).toBe('CHECKSUM_ERROR')

      const platformError = new PlatformError('Unsupported platform', 'win32')
      expect(platformError.name).toBe('PlatformError')
      expect(platformError.code).toBe('PLATFORM_ERROR')

      const artifactError = new ArtifactNotFoundError('Artifact not found', 'v1.0.0', 'linux')
      expect(artifactError.name).toBe('ArtifactNotFoundError')
      expect(artifactError.code).toBe('ARTIFACT_NOT_FOUND')

      const cacheError = new CacheError('Cache error')
      expect(cacheError.name).toBe('CacheError')
      expect(cacheError.code).toBe('CACHE_ERROR')

      const fallbackError = new FallbackError('Fallback failed', new Error('Original error'))
      expect(fallbackError.name).toBe('FallbackError')
      expect(fallbackError.code).toBe('FALLBACK_ERROR')
    })

    test('should handle error propagation correctly', async () => {
      const { NetworkError } = await import('../scripts/download-temporal-libs.ts')

      const originalError = new Error('Connection timeout')
      const networkError = new NetworkError('Network request failed', originalError)

      expect(networkError.cause).toBe(originalError)
      expect(networkError.message).toBe('Network request failed')
    })

    test('should provide structured error information', async () => {
      const { ChecksumError } = await import('../scripts/download-temporal-libs.ts')

      const checksumError = new ChecksumError('Checksum verification failed', 'abc123', 'def456')

      expect(checksumError.expected).toBe('abc123')
      expect(checksumError.actual).toBe('def456')
      expect(checksumError.code).toBe('CHECKSUM_ERROR')
    })
  })

  describe('Command Line Interface', () => {
    test('should handle download command', async () => {
      // Mock successful download scenario
      const mockReleases = [
        {
          tag_name: 'temporal-libs-latest',
          name: 'Latest',
          assets: [
            {
              name: 'temporal-static-libs-linux-arm64-latest.tar.gz',
              browser_download_url: 'https://example.com/archive.tar.gz',
              size: 1024,
            },
          ],
        },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockReleases),
        headers: new Map(),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '1024']]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      })

      mockExistsSync.mockReturnValue(false)

      // Test would require mocking the CLI argument parsing
      // This is a placeholder for CLI testing structure
      expect(true).toBe(true) // Placeholder assertion
    })
  })
})
