import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const composeFile = fileURLToPath(new URL('../examples/hello/temporal/docker-compose.yml', import.meta.url))
const bridgeDir = fileURLToPath(new URL('../native/temporal-bun-bridge-zig', import.meta.url))

const bridgeArtifacts: Record<NodeJS.Platform, string> = {
  linux: 'libtemporal_bun_bridge_zig.so',
  darwin: 'libtemporal_bun_bridge_zig.dylib',
  win32: 'temporal_bun_bridge_zig.dll',
}

const ensureBridgeBuilt = () => {
  const artifact = bridgeArtifacts[process.platform]
  const outputDir = join(bridgeDir, 'zig-out', 'lib')
  if (!artifact) {
    throw new Error(`Unsupported platform: ${process.platform}`)
  }
  if (existsSync(join(outputDir, artifact))) {
    return
  }
  execSync('zig build -Doptimize=ReleaseFast', { cwd: bridgeDir, stdio: 'inherit' })
}

const ensureTemporal = () => {
  execSync(`docker compose -f ${composeFile} up -d`, { cwd: packageDir, stdio: 'inherit' })
}

const shutdownTemporal = () => {
  execSync(`docker compose -f ${composeFile} down`, { cwd: packageDir, stdio: 'inherit' })
}

beforeAll(() => {
  ensureBridgeBuilt()
  ensureTemporal()
})

afterAll(() => {
  shutdownTemporal()
})

test('hello workflow returns greeting', () => {
  const result = spawnSync('bun', ['run', 'examples/hello/run.ts', '--name', 'Grisha'], {
    cwd: packageDir,
    env: { ...process.env, TEMPORAL_BUN_SDK_USE_ZIG: '1' },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'hello example failed')
  }
  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  expect(lines.length).toBeGreaterThanOrEqual(2)
  const runLine = lines.find((line) => line.startsWith('RunId:'))
  expect(runLine).toBeDefined()
  expect(runLine?.split(':')[1].trim().length).toBeGreaterThan(0)
  expect(lines[lines.length - 1]).toBe('Hello, Grisha!')
})
