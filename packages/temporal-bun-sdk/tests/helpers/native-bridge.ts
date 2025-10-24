import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type NativeBridgeArtefact = {
  path: string | null
  kind: 'release' | 'stub' | 'missing'
}

let stubPromise: Promise<NativeBridgeArtefact> | null = null

async function compileStub(): Promise<NativeBridgeArtefact> {
  const rootDir = fileURLToPath(new URL('../..', import.meta.url))
  const targetDir = join(rootDir, 'native/temporal-bun-bridge-zig/zig-out/lib')

  let releaseName: string
  if (process.platform === 'win32') {
    releaseName = 'temporal_bun_bridge_zig.dll'
  } else if (process.platform === 'darwin') {
    releaseName = 'libtemporal_bun_bridge_zig.dylib'
  } else {
    releaseName = 'libtemporal_bun_bridge_zig.so'
  }

  const releaseCandidates: string[] = [join(targetDir, releaseName)]
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (platform && arch) {
    releaseCandidates.push(join(targetDir, platform, arch, releaseName))
  }

  for (const candidate of releaseCandidates) {
    if (existsSync(candidate)) {
      return { path: candidate, kind: 'release' }
    }
  }

  let binaryName: string
  if (process.platform === 'win32') {
    binaryName = 'temporal_bun_bridge_zig_debug.dll'
  } else if (process.platform === 'darwin') {
    binaryName = 'libtemporal_bun_bridge_zig_debug.dylib'
  } else {
    binaryName = 'libtemporal_bun_bridge_zig_debug.so'
  }

  const binaryPath = join(targetDir, binaryName)
  if (existsSync(binaryPath)) {
    return { path: binaryPath, kind: 'stub' }
  }

  const fixturesDir = join(rootDir, 'tests/fixtures')
  const stubSource = join(fixturesDir, 'stub_temporal_bridge.c')
  mkdirSync(targetDir, { recursive: true })

  const compilerArgs: string[] = []
  if (process.platform === 'darwin') {
    compilerArgs.push('-dynamiclib', '-install_name', binaryName)
  } else if (process.platform === 'win32') {
    compilerArgs.push('-shared')
  } else {
    compilerArgs.push('-shared', '-fPIC')
  }
  compilerArgs.push(stubSource, '-o', binaryPath)

  const ccCheck = spawnSync('which', ['cc'], { stdio: 'pipe' })
  if (ccCheck.status !== 0) {
    console.warn('C compiler not available, skipping native bridge stub compilation')
    return { path: null, kind: 'missing' }
  }

  const result = spawnSync('cc', compilerArgs, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.warn('Failed to compile Temporal bridge stub for tests')
    return { path: null, kind: 'missing' }
  }

  return { path: binaryPath, kind: 'stub' }
}

export async function ensureNativeBridgeStub(): Promise<NativeBridgeArtefact> {
  if (!stubPromise) {
    stubPromise = compileStub()
  }
  return await stubPromise
}

export async function importNativeBridge() {
  const artefact = await ensureNativeBridgeStub()
  if (artefact.kind === 'missing') {
    return { module: null, stubPath: artefact.path, isStub: false }
  }
  const module = await import('../../src/internal/core-bridge/native.ts')
  const isStub = artefact.kind === 'stub'
  return { module, stubPath: artefact.path, isStub }
}
