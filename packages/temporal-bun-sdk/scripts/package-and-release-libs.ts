#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

async function findLibraries(searchDir: string): Promise<string[]> {
  const libs: string[] = []

  function scan(dir: string) {
    if (!existsSync(dir)) return

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
      } else if (entry.name.endsWith('.a')) {
        libs.push(fullPath)
      }
    }
  }

  scan(searchDir)
  return libs
}

async function calculateChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)

  for await (const chunk of stream) {
    hash.update(chunk)
  }

  return hash.digest('hex')
}

async function detectPlatform(): Promise<string> {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  const arch = process.arch === 'x64' ? 'x64' : process.arch
  return `${platform}-${arch}`
}

async function main() {
  const version = process.argv[2]

  if (!version) {
    console.error('Usage: bun run package-and-release-libs.ts <version>')
    console.error('Example: bun run package-and-release-libs.ts v1.0.0')
    process.exit(1)
  }

  const platform = await detectPlatform()
  const cacheDir = join(process.cwd(), '.temporal-libs-cache')

  console.log(`📦 Packaging temporal libraries for ${platform}`)
  console.log(`Version: ${version}`)

  // Find libraries in cache
  const libs = await findLibraries(cacheDir)

  if (libs.length === 0) {
    console.error('✗ No static libraries found in cache')
    console.error('Run: bun run libs:download')
    process.exit(1)
  }

  console.log(`Found ${libs.length} libraries:`)
  for (const lib of libs) {
    console.log(`  - ${lib.split('/').pop()}`)
  }

  // Create release directory
  const releaseDir = join(process.cwd(), 'releases', version, platform)
  mkdirSync(releaseDir, { recursive: true })

  // Copy libraries to release directory
  console.log('\n📋 Copying libraries...')
  for (const lib of libs) {
    const dest = join(releaseDir, lib.split('/').pop() as string)
    execSync(`cp "${lib}" "${dest}"`)
  }

  // Create tarball
  const tarballName = `temporal-static-libs-${platform}-${version}.tar.gz`
  const tarballPath = join(process.cwd(), 'releases', tarballName)

  console.log(`\n📦 Creating tarball: ${tarballName}`)
  execSync(`tar -czf "${tarballPath}" -C "${releaseDir}" .`, { stdio: 'inherit' })

  // Calculate checksum
  console.log('🔐 Calculating checksum...')
  const checksum = await calculateChecksum(tarballPath)
  const checksumPath = `${tarballPath}.sha256`
  await Bun.write(checksumPath, `${checksum}  ${tarballName}\n`)

  console.log(`✓ Checksum: ${checksum}`)

  // Create GitHub release
  const tag = `temporal-libs-${version}`
  const title = `Temporal Static Libraries ${version}`
  const notes = `Pre-built Temporal static libraries for ${platform}.

**Platform:** ${platform}
**Libraries:** ${libs.length} files
**Checksum:** ${checksum}

To use: \`bun run libs:download ${version}\``

  console.log(`\n🚀 Creating GitHub release: ${tag}`)

  try {
    execSync(`gh release create "${tag}" --title "${title}" --notes "${notes}" "${tarballPath}" "${checksumPath}"`, {
      stdio: 'inherit',
    })
    console.log('✅ Release created successfully!')
  } catch (error) {
    console.error('✗ Failed to create release')
    console.error('You can manually create it with:')
    console.error(
      `  gh release create "${tag}" --title "${title}" --notes "${notes}" "${tarballPath}" "${checksumPath}"`,
    )
    throw error
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
