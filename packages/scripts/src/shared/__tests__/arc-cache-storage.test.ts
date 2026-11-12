import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = new URL('../../../../../', import.meta.url)
const readRepoFile = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8')
const application = YAML.parse(readRepoFile('argocd/applications/arc/application.yaml'))
const amd64 = application.spec.sources.find(
  (source: { helm?: { valuesObject?: { runnerScaleSetName?: string } } }) =>
    source.helm?.valuesObject?.runnerScaleSetName === 'arc-amd64',
).helm.valuesObject.template.spec

describe('ARC disposable cache storage', () => {
  it('mounts separate large-file scratch and creates private Rust cache homes after copy verification', () => {
    const runner = amd64.containers[0]
    const mounts = runner.volumeMounts as { name: string; mountPath: string; subPath: string }[]
    expect(mounts.find((mount) => mount.mountPath === '/var/tmp')).toEqual({
      name: 'scratch',
      mountPath: '/var/tmp',
      subPath: 'var-tmp',
    })
    expect(mounts.find((mount) => mount.mountPath === '/tmp')?.subPath).toBe('tmp')
    for (const [name, value] of [
      ['CARGO_HOME', '/home/runner/.cache/cargo'],
      ['RUSTUP_HOME', '/home/runner/.cache/rustup'],
    ]) {
      expect(runner.env).toContainEqual({ name, value })
      expect(mounts.some((mount) => mount.name === 'scratch' && value.startsWith(mount.mountPath + '/'))).toBe(true)
    }
    const script = amd64.initContainers[0].args[0] as string
    const createCaches = 'mkdir -p "$stage/cache/cargo" "$stage/cache/rustup"'
    expect(script.indexOf(createCaches)).toBeGreaterThan(script.indexOf('partial cache copy:'))
    expect(script.indexOf('chown -R 1001:1001 "$stage/nix" "$stage/cache"')).toBeGreaterThan(
      script.indexOf(createCaches),
    )
    expect(script.indexOf('post_copy_available_kib=')).toBeGreaterThan(script.indexOf(createCaches))
    expect(script).toContain('mv "$stage/var-tmp" "$scratch/var-tmp"')
    const modeCommands = script
      .split('\n')
      .filter((line) =>
        [
          createCaches,
          'chmod 00700 "$stage/cache/cargo" "$stage/cache/rustup"',
          'chmod 01777 "$stage/var-tmp"',
        ].includes(line.trim()),
      )
    expect(modeCommands).toHaveLength(3)
    const stage = mkdtempSync(join(tmpdir(), 'arc-cache-modes-'))
    try {
      mkdirSync(join(stage, 'cache'))
      mkdirSync(join(stage, 'var-tmp'))
      chmodSync(join(stage, 'cache'), 0o2770)
      chmodSync(join(stage, 'var-tmp'), 0o3777)
      const result = spawnSync('bash', ['-euc', modeCommands.join('\n')], {
        encoding: 'utf8',
        env: { ...process.env, stage },
        timeout: 10_000,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(statSync(join(stage, 'var-tmp')).mode & 0o7777).toBe(0o1777)
      for (const name of ['cargo', 'rustup']) {
        const path = join(stage, 'cache', name)
        expect(statSync(path).mode & 0o7777).toBe(0o700)
        expect(statSync(path).uid).toBe(process.getuid?.())
        expect(statSync(path).dev).toBe(statSync(stage).dev)
      }
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  })

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
