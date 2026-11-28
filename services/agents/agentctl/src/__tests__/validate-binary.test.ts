import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const validator = resolve(import.meta.dir, '../../scripts/validate-binary.ts')

test('binary validation rejects a failed --version even when gRPC version output is healthy', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'agentctl-validate-'))
  try {
    const binary = resolve(directory, 'agentctl')
    await writeFile(
      binary,
      String.raw`#!/bin/sh
case "$1" in
  --version) echo 'startup failed' >&2; exit 7 ;;
  version) printf 'agentctl v0.0.0\nServer version 0.0.0-test\n' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    )

    const { exitCode, stderr } = Bun.spawnSync([process.execPath, validator, '--mock', '--binary', binary], {
      timeout: 4000,
    })

    expect(exitCode).toBe(1)
    expect(stderr.toString()).toContain('agentctl --version failed with exit code 7')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('binary validation extracts and checks a release archive via --archive', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'agentctl-validate-archive-test-'))
  try {
    const binary = resolve(directory, 'agentctl')
    const archive = resolve(directory, 'agentctl-0.0.0-test.tar.gz')
    await writeFile(
      binary,
      String.raw`#!/bin/sh
case "$1" in
  --version) printf 'agentctl v0.0.0\n' ;;
  version) printf 'agentctl v0.0.0\nServer version 0.0.0-test\n' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    )
    const tar = Bun.spawnSync(['tar', '-C', directory, '-czf', archive, 'agentctl'])
    expect(tar.exitCode).toBe(0)

    const { exitCode, stdout, stderr } = Bun.spawnSync([process.execPath, validator, '--mock', '--archive', archive], {
      timeout: 4000,
    })

    expect(exitCode).toBe(0)
    expect(`${stdout.toString()}${stderr.toString()}`).toContain('agentctl compiled binary validated')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
