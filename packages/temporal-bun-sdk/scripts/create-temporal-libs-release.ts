#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PLATFORMS = [
  { os: 'linux', arch: 'arm64', target: 'aarch64-linux-gnu' },
  { os: 'linux', arch: 'x64', target: 'x86_64-linux-gnu' },
  { os: 'macos', arch: 'arm64', target: 'aarch64-macos-none' },
]

async function buildLibraries(platform: string, arch: string, target: string) {
  console.log(`\n🔨 Building for ${platform}-${arch} (${target})...`)

  const buildDir = join(process.cwd(), 'zig-out', target)

  try {
    execSync(`zig build -Doptimize=ReleaseFast -Dtarget=${target} --build-file bruke/build.zig`, {
      stdio: 'inherit',
      env: { ...process.env, USE_PREBUILT_LIBS: 'true' },
    })

    console.log(`✓ Build completed for ${platform}-${arch}`)
    return buildDir
  } catch (error) {
    console.error(`✗ Build failed for ${platform}-${arch}:`, error)
    throw error
  }
}

async function createTarball(buildDir: string, platform: string, arch: string, version: string): Promise<string> {
  const outputDir = join(process.cwd(), 'releases')
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  const tarballName = `temporal-static-libs-${platform}-${arch}-${version}.tar.gz`
  const tarballPath = join(outputDir, tarballName)

  console.log(`📦 Creating tarball: ${tarballName}`)

  execSync(`tar -czf "${tarballPath}" -C "${buildDir}" .`, { stdio: 'inherit' })

  console.log(`✓ Tarball created: ${tarballPath}`)
  return tarballPath
}

async function calculateChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

async function createChecksumFile(tarballPath: string): Promise<string> {
  const checksum = await calculateChecksum(tarballPath)
  const checksumPath = `${tarballPath}.sha256`
  const fileName = tarballPath.split('/').pop()

  await Bun.write(checksumPath, `${checksum}  ${fileName}\n`)

  console.log(`✓ Checksum: ${checksum}`)
  return checksumPath
}

async function createGitHubRelease(version: string, files: string[]) {
  console.log(`\n🚀 Creating GitHub release: temporal-libs-${version}`)

  const tag = `temporal-libs-${version}`
  const title = `Temporal Static Libraries ${version}`
  const notes = `Pre-built Temporal static libraries for supported platforms.

**Platforms:**
- linux-arm64
- linux-x64
- macos-arm64

**Files:**
${files.map((f) => `- ${f.split('/').pop()}`).join('\n')}

Built from temporal-bun-sdk package.`

  try {
    // Create release
    execSync(
      `gh release create "${tag}" --title "${title}" --notes "${notes}" ${files.map((f) => `"${f}"`).join(' ')}`,
      {
        stdio: 'inherit',
      },
    )

    console.log(`✓ Release created: ${tag}`)
  } catch (error) {
    console.error('✗ Failed to create release:', error)
    throw error
  }
}

async function main() {
  const version = process.argv[2] || 'v1.0.0'

  console.log(`Building Temporal static libraries release: ${version}`)
  console.log(`Platforms: ${PLATFORMS.map((p) => `${p.os}-${p.arch}`).join(', ')}`)

  const allFiles: string[] = []

  for (const { os, arch, target } of PLATFORMS) {
    try {
      const buildDir = await buildLibraries(os, arch, target)
      const tarballPath = await createTarball(buildDir, os, arch, version)
      const checksumPath = await createChecksumFile(tarballPath)

      allFiles.push(tarballPath, checksumPath)
    } catch (_error) {
      console.error(`Failed to build ${os}-${arch}, skipping...`)
    }
  }

  if (allFiles.length === 0) {
    console.error('✗ No artifacts were built successfully')
    process.exit(1)
  }

  console.log(`\n📋 Built ${allFiles.length / 2} platform(s)`)

  await createGitHubRelease(version, allFiles)

  console.log('\n✅ Release creation complete!')
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
