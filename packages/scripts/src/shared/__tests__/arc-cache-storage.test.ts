import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8')

describe('ARC disposable cache storage', () => {
  it('routes Kata toolchain installation and Cargo state before Rust setup on existing runners', () => {
    const steps = YAML.parse(readRepoFile('.github/workflows/kata-firecracker-extension.yaml')).jobs.build.steps as {
      name?: string
      run?: string
      uses?: string
    }[]
    const setupIndex = steps.findIndex((step) => step.name === 'Place Rust state on job storage')
    expect(setupIndex).toBeGreaterThan(-1)
    expect(setupIndex).toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('dtolnay/rust-toolchain@')))
    const script = steps[setupIndex].run
    if (!script) throw new Error('Kata Rust storage setup is missing')
    const fixture = mkdtempSync(join(tmpdir(), 'arc-kata-storage-'))
    const runnerTemp = join(fixture, 'runner-temp')
    const githubEnv = join(fixture, 'github-env')
    const paths: string[] = []
    mkdirSync(runnerTemp)
    chmodSync(runnerTemp, 0o2770)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        writeFileSync(githubEnv, '')
        const result = spawnSync('bash', ['-euc', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: githubEnv,
            CARGO_HOME: join(fixture, 'old-cargo'),
            RUSTUP_HOME: join(fixture, 'old-rustup'),
          },
          timeout: 10_000,
        })
        expect(result.status, result.stderr).toBe(0)
        const values = Object.fromEntries(
          readFileSync(githubEnv, 'utf8')
            .trim()
            .split('\n')
            .map((line) => line.split('=')),
        )
        for (const name of ['CARGO_HOME', 'RUSTUP_HOME']) {
          const path = values[name]
          expect(path.startsWith(runnerTemp + '/')).toBe(true)
          expect(statSync(path).mode & 0o7777).toBe(0o700)
          expect(statSync(dirname(path)).mode & 0o7777).toBe(0o700)
          expect(statSync(path).dev).toBe(statSync(runnerTemp).dev)
          expect(statSync(path).uid).toBe(process.getuid?.())
          writeFileSync(join(path, 'write-proof'), 'private job state\n')
          paths.push(path)
        }
      }
      expect(new Set(paths).size).toBe(4)
      expect(statSync(runnerTemp).mode & 0o7777).toBe(0o2770)
      expect(existsSync(join(fixture, 'old-cargo'))).toBe(false)
      expect(existsSync(join(fixture, 'old-rustup'))).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  for (const script of ['nix/oci-inspect-archive.sh', 'nix/oci-push.sh']) {
    it('passes explicit job storage to Skopeo in ' + script, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'arc-skopeo-storage-'))
      const bin = join(fixture, 'bin')
      const runnerTemp = join(fixture, 'runner-temp')
      const fallbackTemp = join(fixture, 'fallback-temp')
      const archive = join(fixture, 'image.tar')
      const calls = join(fixture, 'calls')
      for (const path of [bin, runnerTemp, fallbackTemp]) mkdirSync(path)
      writeFileSync(archive, 'archive fixture\n')
      const executable = (name: string, body: string) =>
        writeFileSync(join(bin, name), '#!/bin/sh\n' + body, { mode: 0o755 })
      executable('readlink', "printf '/nix/store/fixture-image.tar\\n'\n")
      executable('git', 'exit 0\n')
      executable('skopeo', 'printf "%s\\n" "$@" > "$TEST_CALLS"\nprintf \'{"Architecture":"amd64","Os":"linux"}\\n\'\n')
      executable(
        'crane',
        'case "$1" in\nconfig) printf \'{"config":{"Labels":{"org.opencontainers.image.created":"2026-11-12T12:00:00Z","org.opencontainers.image.revision":"1111111111111111111111111111111111111111"}}}\\n\';;\ndigest) printf "sha256:fixture\\n";;\nesac\n',
      )
      try {
        for (const suppliedRunnerTemp of [runnerTemp, '']) {
          const args = script.endsWith('oci-push.sh')
            ? [
                '--image',
                'registry.ide-newton.ts.net/lab/fixture',
                '--tag',
                'fixture',
                '--tar',
                archive,
                '--source-sha',
                '1111111111111111111111111111111111111111',
                '--source-timestamp',
                '2026-11-12T12:00:00Z',
              ]
            : [archive]
          const result = spawnSync('bash', [fileURLToPath(new URL(script, repoRoot)), ...args], {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: bin + ':' + process.env.PATH,
              RUNNER_TEMP: suppliedRunnerTemp,
              TMPDIR: fallbackTemp,
              TEST_CALLS: calls,
              GITHUB_OUTPUT: '',
            },
            timeout: 10_000,
          })
          expect(result.status, result.stderr).toBe(0)
          const argv = readFileSync(calls, 'utf8').trim().split('\n')
          expect(argv.slice(0, 2)).toEqual(['--tmpdir', suppliedRunnerTemp || fallbackTemp])
          expect(argv).toContain('docker-archive:/nix/store/fixture-image.tar')
          if (script.endsWith('oci-push.sh')) {
            expect(argv).toContain('--dest-precompute-digests')
            expect(argv).toContain('--image-parallel-copies')
            expect(argv).toContain('docker://registry.ide-newton.ts.net/lab/fixture:fixture')
          } else {
            expect(argv[2]).toBe('inspect')
          }
        }
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    })
  }
})
