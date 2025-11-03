import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type NativeBridgeArtefact = {
  path: string | null
  kind: 'release' | 'debug' | 'missing'
}

let lookupPromise: Promise<NativeBridgeArtefact> | null = null

async function locateNativeBridge(): Promise<NativeBridgeArtefact> {
  const rootDir = fileURLToPath(new URL('../..', import.meta.url))
  const targetDir = join(rootDir, 'bruke/zig-out/lib')

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
    return { path: binaryPath, kind: 'debug' }
  }

  return { path: null, kind: 'missing' }
}

export async function ensureNativeBridgeStub(): Promise<NativeBridgeArtefact> {
  if (!lookupPromise) {
    lookupPromise = locateNativeBridge()
  }
  return await lookupPromise
}

export async function importNativeBridge() {
  const artefact = await ensureNativeBridgeStub()
  if (artefact.kind === 'missing') {
    return { module: null, stubPath: artefact.path, isStub: true }
  }
  const module = await import('../../src/internal/core-bridge/native')
  const isStub = false
  return { module, stubPath: artefact.path, isStub }
}
