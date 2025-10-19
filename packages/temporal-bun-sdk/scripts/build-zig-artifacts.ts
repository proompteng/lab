/* eslint-disable no-console */
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { $ } from 'bun'
import { artifactFilename, relativeArtifactSubpath, zigTargets } from './zig-targets'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const zigProjectDir = join(rootDir, 'native', 'temporal-bun-bridge-zig')
const buildFile = join(zigProjectDir, 'build.zig')
const toolchainScript = join(rootDir, 'scripts', 'run-with-rust-toolchain.ts')
const zigOutLibDir = join(zigProjectDir, 'zig-out', 'lib')

async function ensureZigInstalled() {
  try {
    await $`zig version`.quiet()
  } catch {
    console.error('Zig is required to build the Temporal Bun bridge artifacts.')
    console.error('Install Zig or ensure it is available on PATH, then retry.')
    process.exitCode = 1
    throw new Error('missing zig command')
  }
}

async function buildTarget(target: (typeof zigTargets)[number]) {
  const destSubpath = relativeArtifactSubpath(target)
  const artifactPath = join(zigOutLibDir, target.platform, target.arch, artifactFilename(target))
  const stageDir = dirname(artifactPath)

  await mkdir(stageDir, { recursive: true })
  await rm(artifactPath, { force: true })

  console.log(`\nBuilding Zig bridge for ${target.triple} → dist/native/${target.platform}/${target.arch}`)
  const command = $`bun run ${toolchainScript} -- zig build -Doptimize=ReleaseFast -Dtarget=${target.triple} -Dinstall-subpath=${destSubpath} --build-file ${buildFile}`
  command.cwd = zigProjectDir
  await command
}

async function main() {
  try {
    await ensureZigInstalled()
    for (const target of zigTargets) {
      await buildTarget(target)
    }
    console.log('\nFinished building Zig bridge artifacts.')
  } catch (error) {
    if (error instanceof Error && error.message === 'missing zig command') {
      return
    }
    if (error instanceof Error) {
      console.error(`\nFailed to compile Zig bridge artifacts: ${error.message}`)
    } else {
      console.error('\nFailed to compile Zig bridge artifacts.')
    }
    process.exitCode = 1
  }
}

await main()
