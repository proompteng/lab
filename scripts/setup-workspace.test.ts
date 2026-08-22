import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = await Bun.file(new URL('./setup-workspace.sh', import.meta.url)).text()
const bootstrapStart = source.indexOf('# BEGIN Bun runtime bootstrap')
const bootstrapEnd = source.indexOf('# END Bun runtime bootstrap', bootstrapStart)
const bootstrap = source.slice(bootstrapStart, bootstrapEnd)

const runBootstrap = async (initialVersion: string, installedVersion: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-workspace-bun-'))
  const installState = join(dir, 'installed')
  const curlCalled = join(dir, 'curl-called')
  const harness = `
    set -u
    BUN_VERSION="1.4.0"
    bun() {
      if [ "\${1:-}" = "--version" ]; then
        if [ -f "$TEST_INSTALL_STATE" ]; then
          printf '%s\\n' "$TEST_INSTALLED_VERSION"
        else
          printf '%s\\n' "$TEST_INITIAL_VERSION"
        fi
      fi
    }
    curl() {
      touch "$TEST_CURL_CALLED"
      printf '#!/usr/bin/env bash\\ntouch %q\\n' "$TEST_INSTALL_STATE"
    }
    ${bootstrap}
  `

  try {
    const process = Bun.spawn(['bash', '-c', harness], {
      env: {
        ...Bun.env,
        HOME: dir,
        TEST_CURL_CALLED: curlCalled,
        TEST_INITIAL_VERSION: initialVersion,
        TEST_INSTALLED_VERSION: installedVersion,
        TEST_INSTALL_STATE: installState,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const [exitCode, stderr, stdout] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
      new Response(process.stdout).text(),
    ])
    return { exitCode, installerCalled: await Bun.file(curlCalled).exists(), stderr, stdout }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('setup workspace upgrades an existing stale Bun runtime', async () => {
  const result = await runBootstrap('1.3.14', '1.4.0')

  expect(result.exitCode).toBe(0)
  expect(result.installerCalled).toBeTrue()
  expect(result.stdout).toContain('Upgrading Bun from 1.3.14 to 1.4.0')
  expect(result.stdout).toContain('Bun 1.4.0 ready')
})

test('setup workspace leaves the pinned Bun runtime in place', async () => {
  const result = await runBootstrap('1.4.0', '1.4.0')

  expect(result.exitCode).toBe(0)
  expect(result.installerCalled).toBeFalse()
  expect(result.stdout).toContain('Bun 1.4.0 ready')
})

test('setup workspace fails when installation does not produce the pinned Bun runtime', async () => {
  const result = await runBootstrap('1.3.14', '1.3.14')

  expect(result.exitCode).toBe(1)
  expect(result.installerCalled).toBeTrue()
  expect(result.stderr).toContain('Bun version mismatch after install: expected 1.4.0, got 1.3.14')
})
