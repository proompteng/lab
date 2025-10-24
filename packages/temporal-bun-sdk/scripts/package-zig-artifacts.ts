/* eslint-disable no-console */
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { artifactFilename, zigTargets } from './zig-targets'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const packageDistDir = join(rootDir, 'dist')
const distNativeDir = join(packageDistDir, 'native')
const zigProjectDir = join(rootDir, 'native', 'temporal-bun-bridge-zig')
const zigLibDir = join(zigProjectDir, 'zig-out', 'lib')

async function assertBuilt(target: (typeof zigTargets)[number]): Promise<string> {
  const stagedPath = join(zigLibDir, target.platform, target.arch, artifactFilename(target))
  try {
    await stat(stagedPath)
  } catch {
    throw new Error(`Missing staged Zig artifact for ${target.triple}. Run build:native:zig:bundle before packaging.`)
  }
  return stagedPath
}

async function copyArtifact(target: (typeof zigTargets)[number]) {
  const stagedPath = await assertBuilt(target)
  const outputDir = join(distNativeDir, target.platform, target.arch)
  const outputPath = join(outputDir, artifactFilename(target))

  await mkdir(outputDir, { recursive: true })
  await rm(outputPath, { force: true })
  await copyFile(stagedPath, outputPath)
  console.log(`Copied ${target.platform}/${target.arch} Zig bridge to ${outputPath}`)
}

async function main() {
  try {
    await mkdir(distNativeDir, { recursive: true })
    for (const target of zigTargets) {
      await copyArtifact(target)
    }
    console.log('Zig bridge artifacts copied into dist/native.')
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to package Zig artifacts: ${error.message}`)
    } else {
      console.error('Failed to package Zig artifacts.')
    }
    process.exitCode = 1
  }
}

await main()
