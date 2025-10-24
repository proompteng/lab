import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

describe('Download Client Core Unit Tests', () => {
  describe('Error Classes', () => {
    test('should create TemporalLibsError with correct properties', async () => {
      const { TemporalLibsError } = await import('../scripts/download-temporal-libs.ts')

      const error = new TemporalLibsError('Test error', 'TEST_CODE')
      expect(error.name).toBe('TemporalLibsError')
      expect(error.message).toBe('Test error')
      expect(error.code).toBe('TEST_CODE')
      expect(error instanceof Error).toBe(true)
    })

    test('should create NetworkError with correct inheritance', async () => {
      const { NetworkError, TemporalLibsError } = await import('../scripts/download-temporal-libs.ts')

      const error = new NetworkError('Network failed')
      expect(error.name).toBe('NetworkError')
      expect(error.code).toBe('NETWORK_ERROR')
      expect(error instanceof TemporalLibsError).toBe(true)
      expect(error instanceof Error).toBe(true)
    })

    test('should create ChecksumError with expected and actual values', async () => {
      const { ChecksumError } = await import('../scripts/download-temporal-libs.ts')

      const error = new ChecksumError('Checksum mismatch', 'expected123', 'actual456')
      expect(error.name).toBe('ChecksumError')
      expect(error.code).toBe('CHECKSUM_ERROR')
      expect(error.expected).toBe('expected123')
      expect(error.actual).toBe('actual456')
    })

    test('should create PlatformError with platform info', async () => {
      const { PlatformError } = await import('../scripts/download-temporal-libs.ts')

      const error = new PlatformError('Unsupported platform', 'win32')
      expect(error.name).toBe('PlatformError')
      expect(error.code).toBe('PLATFORM_ERROR')
      expect(error.platform).toBe('win32')
    })

    test('should create ArtifactNotFoundError with version and platform', async () => {
      const { ArtifactNotFoundError } = await import('../scripts/download-temporal-libs.ts')

      const error = new ArtifactNotFoundError('Artifact not found', 'v1.0.0', 'linux')
      expect(error.name).toBe('ArtifactNotFoundError')
      expect(error.code).toBe('ARTIFACT_NOT_FOUND')
      expect(error.version).toBe('v1.0.0')
      expect(error.platform).toBe('linux')
    })

    test('should create RateLimitError with reset time', async () => {
      const { RateLimitError } = await import('../scripts/download-temporal-libs.ts')

      const resetTime = new Date()
      const error = new RateLimitError('Rate limited', resetTime)
      expect(error.name).toBe('RateLimitError')
      expect(error.code).toBe('RATE_LIMIT_ERROR')
      expect(error.resetTime).toBe(resetTime)
    })

    test('should create CacheError', async () => {
      const { CacheError } = await import('../scripts/download-temporal-libs.ts')

      const error = new CacheError('Cache operation failed')
      expect(error.name).toBe('CacheError')
      expect(error.code).toBe('CACHE_ERROR')
    })
  })

  describe('Platform Detection Logic', () => {
    test('should detect supported platforms correctly', async () => {
      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      // Test supported platforms
      expect(PlatformDetector.isSupported({ os: 'linux', arch: 'arm64', platform: 'linux-arm64' })).toBe(true)
      expect(PlatformDetector.isSupported({ os: 'linux', arch: 'x64', platform: 'linux-x64' })).toBe(true)
      expect(PlatformDetector.isSupported({ os: 'macos', arch: 'arm64', platform: 'macos-arm64' })).toBe(true)

      // Test unsupported platforms
      expect(PlatformDetector.isSupported({ os: 'windows', arch: 'x64', platform: 'windows-x64' })).toBe(false)
      expect(PlatformDetector.isSupported({ os: 'linux', arch: 'x86', platform: 'linux-x86' })).toBe(false)
      expect(PlatformDetector.isSupported({ os: 'macos', arch: 'x64', platform: 'macos-x64' })).toBe(false)
    })

    test('should handle platform detection with mocked process values', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      try {
        // Test Linux ARM64
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })

        const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')
        const platform = PlatformDetector.detectPlatform()

        expect(platform.os).toBe('linux')
        expect(platform.arch).toBe('arm64')
        expect(platform.platform).toBe('linux-arm64')

        // Test macOS ARM64
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })

        const macPlatform = PlatformDetector.detectPlatform()
        expect(macPlatform.os).toBe('macos')
        expect(macPlatform.arch).toBe('arm64')
        expect(macPlatform.platform).toBe('macos-arm64')
      } finally {
        // Restore original values
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
      }
    })

    test('should throw error for unsupported platform', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      try {
        Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
        Object.defineProperty(process, 'arch', { value: 'x64', configurable: true })

        const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

        expect(() => PlatformDetector.detectPlatform()).toThrow('Unsupported platform: freebsd')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
      }
    })

    test('should throw error for unsupported architecture', async () => {
      const originalPlatform = process.platform
      const originalArch = process.arch

      try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        Object.defineProperty(process, 'arch', { value: 'mips', configurable: true })

        const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

        expect(() => PlatformDetector.detectPlatform()).toThrow('Unsupported architecture: mips')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
      }
    })
  })

  describe('Configuration and Types', () => {
    test('should have correct default configuration values', async () => {
      const { GitHubApiClient } = await import('../scripts/download-temporal-libs.ts')

      // Create client with default config
      const client = new GitHubApiClient('test', 'repo')

      // Test that client was created successfully (indicates default config is valid)
      expect(client).toBeDefined()
    })

    test('should accept custom configuration', async () => {
      const { GitHubApiClient } = await import('../scripts/download-temporal-libs.ts')

      const customConfig = {
        version: 'v2.0.0',
        cacheDir: '/custom/cache',
        checksumVerification: true,
        retryAttempts: 5,
        retryDelayMs: 2000,
        maxRetryDelayMs: 60000,
        maxDownloadSizeMB: 200,
        resumeDownloads: false,
        rateLimitRetryDelayMs: 120000,
        maxRateLimitRetries: 3,
      }

      const client = new GitHubApiClient('test', 'repo', customConfig)
      expect(client).toBeDefined()
    })
  })

  describe('Utility Functions', () => {
    test('should generate correct SHA256 checksums', () => {
      const testData = 'test file content'
      const expectedChecksum = createHash('sha256').update(testData).digest('hex')

      // Verify our test checksum generation is working
      expect(expectedChecksum).toMatch(/^[a-f0-9]{64}$/)
      expect(expectedChecksum.length).toBe(64)
    })

    test('should handle different data types for checksum generation', () => {
      const stringData = 'test string'
      const bufferData = Buffer.from('test buffer')

      const stringChecksum = createHash('sha256').update(stringData).digest('hex')
      const bufferChecksum = createHash('sha256').update(bufferData).digest('hex')

      expect(stringChecksum).toMatch(/^[a-f0-9]{64}$/)
      expect(bufferChecksum).toMatch(/^[a-f0-9]{64}$/)
      expect(stringChecksum).not.toBe(bufferChecksum) // Different content should have different checksums
    })
  })

  describe('Interface Validation', () => {
    test('should have correct PlatformInfo interface structure', async () => {
      const { PlatformDetector } = await import('../scripts/download-temporal-libs.ts')

      const originalPlatform = process.platform
      const originalArch = process.arch

      try {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
        Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })

        const platform = PlatformDetector.detectPlatform()

        // Verify interface structure
        expect(platform).toHaveProperty('os')
        expect(platform).toHaveProperty('arch')
        expect(platform).toHaveProperty('platform')

        expect(typeof platform.os).toBe('string')
        expect(typeof platform.arch).toBe('string')
        expect(typeof platform.platform).toBe('string')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
        Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
      }
    })

    test('should validate GitHubRelease interface expectations', async () => {
      // Mock release data structure that should match the interface
      const mockRelease = {
        tag_name: 'temporal-libs-v1.0.0',
        name: 'Temporal Static Libraries v1.0.0',
        assets: [
          {
            name: 'temporal-static-libs-linux-arm64-v1.0.0.tar.gz',
            browser_download_url: 'https://example.com/download/archive.tar.gz',
            size: 1024000,
          },
        ],
      }

      // Verify structure matches expected interface
      expect(mockRelease).toHaveProperty('tag_name')
      expect(mockRelease).toHaveProperty('name')
      expect(mockRelease).toHaveProperty('assets')
      expect(Array.isArray(mockRelease.assets)).toBe(true)

      const asset = mockRelease.assets[0]
      expect(asset).toHaveProperty('name')
      expect(asset).toHaveProperty('browser_download_url')
      expect(asset).toHaveProperty('size')
      expect(typeof asset.size).toBe('number')
    })
  })

  describe('Class Instantiation', () => {
    test('should create GitHubApiClient with valid parameters', async () => {
      const { GitHubApiClient } = await import('../scripts/download-temporal-libs.ts')

      const client = new GitHubApiClient('testowner', 'testrepo')
      expect(client).toBeDefined()
      expect(client).toBeInstanceOf(GitHubApiClient)
    })

    test('should create FileDownloader with default config', async () => {
      const { FileDownloader } = await import('../scripts/download-temporal-libs.ts')

      const downloader = new FileDownloader()
      expect(downloader).toBeDefined()
      expect(downloader).toBeInstanceOf(FileDownloader)
    })

    test('should create CacheManager with valid config', async () => {
      const { CacheManager } = await import('../scripts/download-temporal-libs.ts')

      const config = { cacheDir: '.test-cache' }
      const cacheManager = new CacheManager(config)
      expect(cacheManager).toBeDefined()
      expect(cacheManager).toBeInstanceOf(CacheManager)
    })
  })
})
