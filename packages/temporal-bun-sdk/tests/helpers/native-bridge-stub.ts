import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('../..', import.meta.url))
const targetDir = join(packageDir, 'native', 'temporal-bun-bridge', 'target')

const stubLibraryName = (() => {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge.dylib'
  }
  return 'libtemporal_bun_bridge.so'
})()

const stubLibraryPath = join(targetDir, 'debug', stubLibraryName)

const fixturesDir = join(packageDir, 'tests', 'fixtures')
const stubSource = join(fixturesDir, 'stub_temporal_bridge.c')

export function ensureNativeBridgeStub(): string {
  const needsRebuild = !existsSync(stubLibraryPath) || statSync(stubLibraryPath).mtimeMs < statSync(stubSource).mtimeMs
  if (needsRebuild) {
    mkdirSync(join(targetDir, 'debug'), { recursive: true })

    const compilerArgs: string[] = []
    if (process.platform === 'darwin') {
      compilerArgs.push('-dynamiclib')
    } else if (process.platform === 'win32') {
      compilerArgs.push('-shared')
    } else {
      compilerArgs.push('-shared', '-fPIC')
    }
    compilerArgs.push(stubSource, '-o', stubLibraryPath)

    const result = spawnSync('cc', compilerArgs, { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error('Failed to compile Temporal bridge stub for tests')
    }
  }

  return stubLibraryPath
}
