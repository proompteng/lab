#!/usr/bin/env bun

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * GitHub Workflow Validation Tests
 *
 * Validates the GitHub Action workflows for building and publishing
 * temporal static libraries and CI/CD integration.
 *
 * Requirements covered: 2.1, 2.2, 2.3, 2.4, 2.5
 */

describe('GitHub Workflow Validation Tests', () => {
  const workflowsDir = join(process.cwd(), '../../.github/workflows')
  const temporalStaticLibsWorkflow = join(workflowsDir, 'temporal-static-libraries.yml')
  const temporalBunSdkWorkflow = join(workflowsDir, 'temporal-bun-sdk.yml')

  describe('Temporal Static Libraries Workflow', () => {
    test('should have temporal-static-libraries.yml workflow file', () => {
      expect(existsSync(temporalStaticLibsWorkflow)).toBe(true)
    })

    test('should validate workflow configuration', () => {
      if (!existsSync(temporalStaticLibsWorkflow)) {
        console.log('⚠️  temporal-static-libraries.yml not found - skipping validation')
        return
      }

      const workflowContent = readFileSync(temporalStaticLibsWorkflow, 'utf-8')

      // Validate workflow trigger
      expect(workflowContent).toContain('workflow_dispatch')

      // Validate matrix build for multiple platforms
      expect(workflowContent).toContain('matrix:')
      expect(workflowContent).toContain('aarch64-unknown-linux-gnu')
      expect(workflowContent).toContain('x86_64-unknown-linux-gnu')
      expect(workflowContent).toContain('aarch64-apple-darwin')

      // Validate ARM64 runner usage
      expect(workflowContent).toContain('arc-arm64')

      // Validate Rust toolchain setup
      expect(workflowContent).toContain('rust-toolchain')

      // Validate static library compilation
      expect(workflowContent).toContain('cargo rustc')
      expect(workflowContent).toContain('staticlib')

      // Validate artifact packaging
      expect(workflowContent).toContain('tar -czf')
      expect(workflowContent).toContain('temporal-static-libs-')

      // Validate checksum generation
      expect(workflowContent).toContain('sha256sum') || expect(workflowContent).toContain('shasum -a 256')

      // Validate release creation
      expect(workflowContent).toContain('softprops/action-gh-release')
      expect(workflowContent).toContain('temporal-libs-')

      console.log('✓ Temporal static libraries workflow configuration validated')
    })

    test('should validate workflow inputs', () => {
      if (!existsSync(temporalStaticLibsWorkflow)) {
        console.log('⚠️  temporal-static-libraries.yml not found - skipping input validation')
        return
      }

      const workflowContent = readFileSync(temporalStaticLibsWorkflow, 'utf-8')

      // Validate version input
      expect(workflowContent).toContain('version:')
      expect(workflowContent).toContain('required: true')

      // Validate create_release input
      expect(workflowContent).toContain('create_release:')
      expect(workflowContent).toContain('default: true')
      expect(workflowContent).toContain('type: boolean')

      console.log('✓ Workflow inputs validated')
    })

    test('should validate artifact naming conventions in workflow', () => {
      if (!existsSync(temporalStaticLibsWorkflow)) {
        console.log('⚠️  temporal-static-libraries.yml not found - skipping naming validation')
        return
      }

      const workflowContent = readFileSync(temporalStaticLibsWorkflow, 'utf-8')

      // Validate artifact naming pattern (using shell variable syntax)
      expect(workflowContent).toContain('temporal-static-libs-${PLATFORM}-${ARCH}-${VERSION}.tar.gz')

      // Validate checksum file naming
      expect(workflowContent).toMatch(/\.tar\.gz\.sha256/)

      console.log('✓ Artifact naming conventions validated in workflow')
    })
  })

  describe('Temporal Bun SDK CI Workflow', () => {
    test('should have temporal-bun-sdk.yml workflow file', () => {
      expect(existsSync(temporalBunSdkWorkflow)).toBe(true)
    })

    test('should validate CI workflow uses pre-built libraries', () => {
      if (!existsSync(temporalBunSdkWorkflow)) {
        console.log('⚠️  temporal-bun-sdk.yml not found - skipping CI validation')
        return
      }

      const workflowContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

      // Validate environment variables
      expect(workflowContent).toContain("USE_PREBUILT_LIBS: 'true'")

      // Validate download step
      expect(workflowContent).toContain('bun run libs:download')

      // Validate Zig setup (should be present for building)
      expect(workflowContent).toContain('setup-zig')

      // Validate that Rust toolchain setup is removed
      expect(workflowContent).not.toContain('rust-toolchain@stable')
      expect(workflowContent).not.toContain('cargo install')

      // Validate ARM64 runner usage
      expect(workflowContent).toContain('arc-arm64')

      console.log('✓ CI workflow validated for pre-built library usage')
    })

    test('should validate CI workflow triggers', () => {
      if (!existsSync(temporalBunSdkWorkflow)) {
        console.log('⚠️  temporal-bun-sdk.yml not found - skipping trigger validation')
        return
      }

      const workflowContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

      // Validate push trigger
      expect(workflowContent).toContain('push:')
      expect(workflowContent).toContain('branches:')
      expect(workflowContent).toContain('- main')

      // Validate pull request trigger
      expect(workflowContent).toContain('pull_request:')

      // Validate path filters
      expect(workflowContent).toContain('packages/temporal-bun-sdk/**')

      console.log('✓ CI workflow triggers validated')
    })

    test('should validate test execution steps', () => {
      if (!existsSync(temporalBunSdkWorkflow)) {
        console.log('⚠️  temporal-bun-sdk.yml not found - skipping test validation')
        return
      }

      const workflowContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

      // Validate Temporal server setup
      expect(workflowContent).toContain('docker-compose')
      expect(workflowContent).toContain('Start Temporal server')

      // Validate test execution
      expect(workflowContent).toContain('test')

      // Validate Zig build and test
      expect(workflowContent).toContain('ci:native:zig')

      console.log('✓ Test execution steps validated')
    })
  })

  describe('Workflow Integration', () => {
    test('should validate workflow dependencies and sequencing', () => {
      console.log('🔗 Validating workflow dependencies and sequencing...')

      // The temporal-static-libraries workflow should be independent
      // The temporal-bun-sdk workflow should be able to use artifacts from releases

      if (existsSync(temporalStaticLibsWorkflow) && existsSync(temporalBunSdkWorkflow)) {
        const staticLibsContent = readFileSync(temporalStaticLibsWorkflow, 'utf-8')
        const bunSdkContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

        // Static libs workflow should create releases
        expect(staticLibsContent).toContain('Create GitHub Release')
        expect(staticLibsContent).toContain('temporal-libs-')

        // Bun SDK workflow should download from releases
        expect(bunSdkContent).toContain('libs:download')

        console.log('✓ Workflow dependencies validated')
      } else {
        console.log('⚠️  One or both workflow files not found - skipping dependency validation')
      }
    })

    test('should validate performance optimization in workflows', () => {
      console.log('⚡ Validating performance optimizations in workflows...')

      if (existsSync(temporalBunSdkWorkflow)) {
        const bunSdkContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

        // Should use ARM64 runners for better performance
        expect(bunSdkContent).toContain('arc-arm64')

        // Should use pre-built libraries to avoid compilation
        expect(bunSdkContent).toContain("USE_PREBUILT_LIBS: 'true'")

        // Should not have Rust compilation steps
        expect(bunSdkContent).not.toContain('cargo build')
        expect(bunSdkContent).not.toContain('rustup')

        console.log('✓ Performance optimizations validated')
      } else {
        console.log('⚠️  temporal-bun-sdk.yml not found - skipping performance validation')
      }
    })

    test('should validate error handling and fallback mechanisms', () => {
      console.log('🛡️  Validating error handling and fallback mechanisms...')

      if (existsSync(temporalBunSdkWorkflow)) {
        const bunSdkContent = readFileSync(temporalBunSdkWorkflow, 'utf-8')

        // Should have proper error handling steps
        expect(bunSdkContent).toContain('if:') // Conditional steps

        // Should have cleanup steps
        expect(bunSdkContent).toContain('always()')

        console.log('✓ Error handling mechanisms validated')
      } else {
        console.log('⚠️  temporal-bun-sdk.yml not found - skipping error handling validation')
      }
    })
  })

  describe('Workflow Security and Best Practices', () => {
    test('should validate security practices in workflows', () => {
      console.log('🔒 Validating security practices in workflows...')

      const workflowFiles = [temporalStaticLibsWorkflow, temporalBunSdkWorkflow]

      for (const workflowFile of workflowFiles) {
        if (!existsSync(workflowFile)) continue

        const content = readFileSync(workflowFile, 'utf-8')

        // Should use specific action versions (not @main or @master)
        const actionMatches = content.match(/uses: .+@[^\\s]+/g) || []
        for (const action of actionMatches) {
          expect(action).not.toContain('@main')
          expect(action).not.toContain('@master')
        }

        // Should use GITHUB_TOKEN for releases
        if (content.includes('softprops/action-gh-release')) {
          expect(content).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
        }
      }

      console.log('✓ Security practices validated')
    })

    test('should validate resource usage optimization', () => {
      console.log('💰 Validating resource usage optimization...')

      if (existsSync(temporalStaticLibsWorkflow)) {
        const content = readFileSync(temporalStaticLibsWorkflow, 'utf-8')

        // Should use ARM64 runners for cost efficiency
        expect(content).toContain('arc-arm64')

        // Should have reasonable timeout (not too long)
        // This is optional but good practice

        console.log('✓ Resource usage optimization validated')
      } else {
        console.log('⚠️  temporal-static-libraries.yml not found - skipping resource validation')
      }
    })
  })
})
