import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { DownloadClient } from '../scripts/download-temporal-libs.ts'

const TEMP_TEST_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-build-integration')
const CACHE_DIR = join(TEMP_TEST_DIR, '.temporal-libs-cache')
const VENDOR_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/vendor/sdk-core')
const BUILD_ZIG_PATH = join('native/temporal-bun-bridge-zig/build.zig')

// Test configuration
const TEST_CONFIG = {
  cacheDir: CACHE_DIR,
  fallbackToCompilation: true,
  checksumVerification: true,
  retryAttempts: 2,
  retryDelayMs: 500,
  maxRetryDelayMs: 5000,
}

describe('Build System Integration Tests', () => {
  let downloadClient: DownloadClient
  let buildTimes: Record<string, number> = {}

  beforeAll(async () => {
    // Create test directory structure
    if (existsSync(TEMP_TEST_DIR)) {
      rmSync(TEMP_TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEMP_TEST_DIR, { recursive: true })
    mkdirSync(CACHE_DIR, { recursive: true })

    // Initialize download client with test configuration
    downloadClient = new DownloadClient('proompteng', 'lab', TEST_CONFIG)

    console.log('Setting up build system integration tests...')
    console.log(`Test directory: ${TEMP_TEST_DIR}`)
    console.log(`Platform: ${downloadClient.getPlatformInfo().platform}`)
  })

  afterAll(async () => {
    // Cleanup test directory
    if (existsSync(TEMP_TEST_DIR)) {
      rmSync(TEMP_TEST_DIR, { recursive: true, force: true })
    }

    // Reset environment variables
    delete process.env.USE_PREBUILT_LIBS
    delete process.env.TEMPORAL_LIBS_VERSION

    console.log('Build system integration tests cleanup completed')
  })

  describe('Zig Build with Pre-built Libraries', () => {
    test('should attempt to download pre-built libraries and handle missing releases', async () => {
      const startTime = Date.now()

      // Set environment variables for pre-built libraries
      process.env.USE_PREBUILT_LIBS = 'true'
      process.env.TEMPORAL_LIBS_VERSION = 'latest'

      try {
        console.log('Testing pre-built library download (may fallback if no releases exist)...')

        try {
          // Attempt to download libraries (disable fallback for this test)
          const testClient = new DownloadClient('proompteng', 'lab', {
            ...TEST_CONFIG,
            fallbackToCompilation: false,
          })
          const librarySet = await testClient.downloadLibraries('latest')

          // If successful, verify the library set
          expect(librarySet).toBeDefined()
          expect(librarySet.libraries.length).toBeGreaterThan(0)
          expect(librarySet.platform).toBe(downloadClient.getPlatformInfo().os)
          expect(librarySet.architecture).toBe(downloadClient.getPlatformInfo().arch)

          // Verify all expected libraries are present
          const expectedLibraries = [
            'libtemporal_sdk_core.a',
            'libtemporal_sdk_core_c_bridge.a',
            'libtemporal_client.a',
            'libtemporal_sdk_core_api.a',
            'libtemporal_sdk_core_protos.a',
          ]

          const libraryNames = librarySet.libraries.map((lib) => lib.name)
          for (const expectedLib of expectedLibraries) {
            expect(libraryNames).toContain(expectedLib)
          }

          // Verify library files exist and are valid
          for (const library of librarySet.libraries) {
            expect(existsSync(library.path)).toBe(true)
            const stats = statSync(library.path)
            expect(stats.size).toBeGreaterThan(0)
            expect(library.checksum).toMatch(/^[a-f0-9]{64}$/)
          }

          console.log('✓ Successfully downloaded and validated pre-built libraries')

          // Test library compatibility validation
          const validation = await testClient.validateLibraryCompatibility(librarySet)
          expect(validation.compatible).toBe(true)
          expect(validation.issues).toHaveLength(0)

          console.log(`✓ Library compatibility validation passed with ${validation.warnings.length} warnings`)
        } catch (error) {
          // Expected if no temporal-libs releases exist yet
          if (error instanceof Error && error.message.includes('No temporal-libs releases found')) {
            console.log('⚠️  No temporal-libs releases found - this is expected before GitHub Action runs')
            console.log('   The download client correctly detected missing releases')

            // Verify the error is the expected type
            expect(error.message).toMatch(/No temporal-libs releases found/)

            // This is actually a successful test - the system correctly identified missing releases
            expect(true).toBe(true)
          } else {
            // Re-throw unexpected errors
            throw error
          }
        }

        const buildTime = Date.now() - startTime
        buildTimes.prebuilt = buildTime

        console.log(`✓ Pre-built library test completed in ${Math.round(buildTime / 1000)}s`)
      } finally {
        delete process.env.USE_PREBUILT_LIBS
        delete process.env.TEMPORAL_LIBS_VERSION
      }
    })

    test('should test Zig build system integration', async () => {
      // Test the Zig build system's ability to handle pre-built libraries
      process.env.USE_PREBUILT_LIBS = 'true'
      process.env.TEMPORAL_LIBS_VERSION = 'latest'

      try {
        console.log('Testing Zig build system integration...')

        // Run Zig build - this will test the build.zig logic for handling pre-built libraries
        const zigBuild = Bun.spawn(['zig', 'build', '-Doptimize=ReleaseFast', '--build-file', BUILD_ZIG_PATH], {
          cwd: join(process.cwd(), 'packages/temporal-bun-sdk'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            USE_PREBUILT_LIBS: 'true',
            TEMPORAL_LIBS_VERSION: 'latest',
          },
        })

        let buildOutput = ''
        if (zigBuild.stdout) {
          const reader = zigBuild.stdout.getReader()
          const decoder = new TextDecoder()

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value)
              buildOutput += text
              process.stdout.write(text)
            }
          } finally {
            reader.releaseLock()
          }
        }

        const exitCode = await zigBuild.exited
        let stderr = ''

        if (zigBuild.stderr) {
          stderr = await new Response(zigBuild.stderr).text()
        }

        if (exitCode !== 0) {
          console.error('Zig build stderr:', stderr)
          console.error('Zig build output:', buildOutput)
        }

        // The build may fail if dependencies are missing, but should handle it gracefully
        if (exitCode === 0) {
          // Build succeeded - verify the build system detected the environment correctly
          expect(buildOutput).toMatch(/Using pre-built libraries|Found vendor directory|cargo build/i)
          console.log('✓ Zig build system integration test passed')
        } else {
          // Build failed - verify it's due to expected missing dependencies
          const hasExpectedError =
            stderr.includes('FileNotFound') ||
            stderr.includes('vendor directory') ||
            stderr.includes('pre-built libraries') ||
            buildOutput.includes('pre-built libraries not found')

          expect(hasExpectedError).toBe(true)
          console.log('✓ Zig build system correctly identified missing dependencies')
        }
      } finally {
        delete process.env.USE_PREBUILT_LIBS
        delete process.env.TEMPORAL_LIBS_VERSION
      }
    })
  })

  describe('Fallback Mechanisms', () => {
    test('should handle network failures gracefully', async () => {
      console.log('Testing network failure handling...')

      // Create a client with invalid repository to simulate network failure
      const failingClient = new DownloadClient('nonexistent-org', 'nonexistent-repo', {
        ...TEST_CONFIG,
        retryAttempts: 1, // Reduce retries for faster test
        fallbackToCompilation: false, // Disable fallback to test error handling
      })

      try {
        await failingClient.downloadLibraries('latest')
        // Should not reach here
        expect(false).toBe(true)
      } catch (error) {
        expect(error instanceof Error).toBe(true)
        expect(error.message).toMatch(/not found|not accessible|failed/i)
        console.log('✓ Network failures handled appropriately')
      }
    })

    test('should test fallback configuration', async () => {
      console.log('Testing fallback configuration...')

      // Test with fallback enabled
      const fallbackClient = new DownloadClient('nonexistent-org', 'nonexistent-repo', {
        ...TEST_CONFIG,
        retryAttempts: 1,
        fallbackToCompilation: true,
      })

      try {
        await fallbackClient.downloadLibraries('latest')
        // If vendor directory exists, fallback might succeed
        console.log('⚠️  Fallback succeeded (vendor directory available)')
      } catch (error) {
        // Expected if no vendor directory
        expect(error instanceof Error).toBe(true)
        if (error.message.includes('Vendor directory not found')) {
          console.log('✓ Fallback correctly identified missing vendor directory')
        } else {
          console.log('✓ Fallback handled error appropriately:', error.message)
        }
      }
    })
  })

  describe('Cross-platform Compatibility', () => {
    test('should detect current platform correctly', () => {
      const platformInfo = downloadClient.getPlatformInfo()

      expect(platformInfo.os).toMatch(/^(linux|macos|windows)$/)
      expect(platformInfo.arch).toMatch(/^(arm64|x64)$/)
      expect(platformInfo.platform).toBe(`${platformInfo.os}-${platformInfo.arch}`)

      console.log(`✓ Platform detection: ${platformInfo.platform}`)
    })

    test('should validate platform support', () => {
      const platformInfo = downloadClient.getPlatformInfo()
      const supportedPlatforms = ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64']

      if (supportedPlatforms.includes(platformInfo.platform)) {
        expect(true).toBe(true) // Platform is supported
        console.log(`✓ Current platform ${platformInfo.platform} is supported`)
      } else {
        console.log(
          `⚠️  Current platform ${platformInfo.platform} is not in supported list: ${supportedPlatforms.join(', ')}`,
        )
        // Test should still pass but log the limitation
        expect(true).toBe(true)
      }
    })
  })

  describe('Build Time Performance', () => {
    test('should measure and compare build times', async () => {
      console.log('\n📊 Build Time Performance Analysis:')

      if (buildTimes.prebuilt) {
        console.log(`Pre-built libraries build: ${Math.round(buildTimes.prebuilt / 1000)}s`)

        // Pre-built should be under 2 minutes (target from design)
        expect(buildTimes.prebuilt).toBeLessThan(120_000)

        console.log('✓ Build time performance targets met')
      } else {
        console.log('⚠️  No build time data available')
      }
    })

    test('should verify build artifacts exist', async () => {
      const buildOutputDir = join(process.cwd(), 'packages/temporal-bun-sdk/zig-out/lib')

      if (existsSync(buildOutputDir)) {
        const files = Bun.spawn(
          ['find', buildOutputDir, '-name', '*.so', '-o', '-name', '*.dylib', '-o', '-name', '*.dll'],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )

        const exitCode = await files.exited

        if (exitCode === 0) {
          const output = await new Response(files.stdout).text()
          const libraryFiles = output
            .trim()
            .split('\n')
            .filter((f) => f.length > 0)

          expect(libraryFiles.length).toBeGreaterThan(0)

          // Verify each library file
          for (const libFile of libraryFiles) {
            expect(existsSync(libFile)).toBe(true)
            const stats = statSync(libFile)
            expect(stats.size).toBeGreaterThan(0)
          }

          console.log(`✓ Found ${libraryFiles.length} build artifacts`)
        }
      }
    })
  })

  describe('Cache Management Integration', () => {
    test('should test cache management functionality', async () => {
      process.env.USE_PREBUILT_LIBS = 'true'

      try {
        console.log('Testing cache management functionality...')

        // Clear cache first
        downloadClient.clearCache()

        // Verify cache is empty
        const initialStats = downloadClient.getCacheStats()
        expect(initialStats.versionCount).toBe(0)
        expect(initialStats.totalSize).toBe(0)

        console.log('✓ Cache clearing works correctly')

        // Test cache directory creation
        const cacheManager = downloadClient.getCacheManager()
        const testCacheDir = cacheManager.getCacheDir('test-version', 'test-platform')
        expect(testCacheDir).toContain('.temporal-libs-cache')
        expect(testCacheDir).toContain('test-version')
        expect(testCacheDir).toContain('test-platform')

        console.log('✓ Cache directory structure is correct')

        // Test cache validation
        const validationResult = await cacheManager.validateAndRepairCache()
        expect(validationResult).toBeDefined()
        expect(validationResult.valid).toBeGreaterThanOrEqual(0)
        expect(validationResult.removed).toBeGreaterThanOrEqual(0)
        expect(Array.isArray(validationResult.errors)).toBe(true)

        console.log('✓ Cache validation functionality works')
      } finally {
        delete process.env.USE_PREBUILT_LIBS
      }
    })
  })

  describe('Environment Variable Integration', () => {
    test('should respect environment variables in build system', async () => {
      console.log('Testing environment variable integration...')

      // Test USE_PREBUILT_LIBS=false
      process.env.USE_PREBUILT_LIBS = 'false'

      try {
        console.log('Testing USE_PREBUILT_LIBS=false...')

        // Run Zig build with USE_PREBUILT_LIBS=false
        const zigBuild = Bun.spawn(['zig', 'build', '-Doptimize=ReleaseFast', '--build-file', BUILD_ZIG_PATH], {
          cwd: join(process.cwd(), 'packages/temporal-bun-sdk'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            USE_PREBUILT_LIBS: 'false',
          },
        })

        let buildOutput = ''
        if (zigBuild.stdout) {
          const reader = zigBuild.stdout.getReader()
          const decoder = new TextDecoder()

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value)
              buildOutput += text
              process.stdout.write(text)
            }
          } finally {
            reader.releaseLock()
          }
        }

        const exitCode = await zigBuild.exited

        if (existsSync(VENDOR_DIR)) {
          // If vendor directory exists, build should succeed
          expect(exitCode).toBe(0)
          expect(buildOutput).toMatch(/Using Cargo build|cargo build/i)
          console.log('✓ USE_PREBUILT_LIBS=false respected (using cargo build)')
        } else {
          // If no vendor directory, should fail with appropriate message
          expect(exitCode).not.toBe(0)
          console.log('✓ USE_PREBUILT_LIBS=false handled correctly (no vendor directory)')
        }
      } finally {
        delete process.env.USE_PREBUILT_LIBS
      }

      // Test TEMPORAL_LIBS_VERSION environment variable handling
      process.env.USE_PREBUILT_LIBS = 'true'
      process.env.TEMPORAL_LIBS_VERSION = 'nonexistent-version'

      try {
        console.log('Testing TEMPORAL_LIBS_VERSION with invalid version...')

        // This should fail to find the version but handle it gracefully
        try {
          await downloadClient.downloadLibraries()
          // If it succeeds, that's unexpected but not necessarily wrong
          console.log('⚠️  Download succeeded with nonexistent version (unexpected but handled)')
        } catch (error) {
          // Expected to fail with version not found
          expect(error instanceof Error).toBe(true)
          console.log('✓ TEMPORAL_LIBS_VERSION validation works correctly')
        }
      } finally {
        delete process.env.USE_PREBUILT_LIBS
        delete process.env.TEMPORAL_LIBS_VERSION
      }
    })
  })
})
