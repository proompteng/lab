import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'

const repoRoot = new URL('../../../../../', import.meta.url)
const wrapper = fileURLToPath(new URL('devices/galactic/extensions/kata/with-job-docker.sh', repoRoot))
const readRepo = (path: string) => readFileSync(new URL(path, repoRoot), 'utf8')

const fixture = (exitCode = 0, failStartup = false) => {
  const root = mkdtempSync(join(tmpdir(), 'kata-job-runtime-'))
  const bin = join(root, 'bin')
  const runnerTemp = join(root, 'runner-temp')
  mkdirSync(bin)
  mkdirSync(runnerTemp)
  chmodSync(runnerTemp, 0o2770)
  const executable = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ['#!/usr/bin/env bash', 'set -euo pipefail', ...lines, ''].join('\n'), {
      mode: 0o755,
    })
  }
  executable('sudo', ['[[ "$1" == -n ]] && shift', 'exec "$@"'])
  executable('dockerd', [
    'printf "%s\\n" "$@" > "$FIXTURE_ROOT/daemon-args"',
    'printf "%s" "$DOCKER_TMPDIR" > "$FIXTURE_ROOT/daemon-tmp"',
    'if [[ "$FAIL_STARTUP" == 1 ]]; then echo "fixture startup failure"; exit 9; fi',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --pidfile) pidfile="$2"; shift 2 ;;',
    '    --data-root) data_root="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'printf "%s" "$$" > "$pidfile"',
    'printf "%s" "$$" > "$FIXTURE_ROOT/daemon-pid"',
    'printf "%s" "$data_root" > "$FIXTURE_ROOT/daemon-root"',
    'trap \'echo stopped > "$FIXTURE_ROOT/stopped"; exit 0\' TERM',
    'while :; do sleep 0.05; done',
  ])
  executable('docker', [
    'if [[ "$1" == info ]]; then cat "$FIXTURE_ROOT/daemon-root"; exit 0; fi',
    'printf "%s|" "$@" >> "$FIXTURE_ROOT/cli"',
    'printf "\\n" >> "$FIXTURE_ROOT/cli"',
    'printf "%s\\n" "$DOCKER_HOST" "$DOCKER_CONFIG" > "$FIXTURE_ROOT/client-paths"',
    'if env | grep -E "^(DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDX_BUILDER|BUILDKIT_HOST)="; then exit 19; fi',
  ])
  const result = spawnSync(
    'bash',
    [
      wrapper,
      'bash',
      '-c',
      'docker pull fixture && docker run --rm fixture /bin/true && docker build -t fixture . && docker buildx build -t fixture .; exit "$PAYLOAD_EXIT"',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: runnerTemp,
        FIXTURE_ROOT: root,
        PAYLOAD_EXIT: String(exitCode),
        FAIL_STARTUP: failStartup ? '1' : '0',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        DOCKER_CONTEXT: 'unrelated-context',
        DOCKER_TLS_VERIFY: '1',
        BUILDKIT_HOST: 'unix:///unrelated-buildkit.sock',
      },
    },
  )
  return { root, runnerTemp, result, state: join(runnerTemp, readdirSync(runnerTemp)[0] ?? 'missing') }
}

describe('Kata job-owned Docker runtime', () => {
  for (const exitCode of [0, 7]) {
    it('isolates runtime storage and preserves command status ' + exitCode, () => {
      const { root, runnerTemp, result, state } = fixture(exitCode)
      try {
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(exitCode)
        expect(statSync(state).mode & 0o7777).toBe(0o700)
        expect(statSync(state).dev).toBe(statSync(runnerTemp).dev)
        expect(statSync(runnerTemp).mode & 0o7777).toBe(0o2770)
        const args = readFileSync(join(root, 'daemon-args'), 'utf8').trim().split('\n')
        for (const [flag, value] of [
          ['--data-root', join(state, 'data')],
          ['--exec-root', join(state, 'exec')],
          ['--pidfile', join(state, 'dockerd.pid')],
          ['--config-file', join(state, 'daemon.json')],
          ['--host', 'unix://' + join(state, 'docker.sock')],
          ['--bridge', 'none'],
        ]) {
          expect(args[args.indexOf(flag) + 1]).toBe(value)
        }
        for (const flag of ['--iptables=false', '--ip6tables=false', '--ip-forward=false', '--ip-masq=false']) {
          expect(args).toContain(flag)
        }
        expect(readFileSync(join(root, 'daemon-tmp'), 'utf8')).toBe(join(state, 'tmp'))
        expect(readFileSync(join(root, 'client-paths'), 'utf8').trim().split('\n')).toEqual([
          'unix://' + join(state, 'docker.sock'),
          join(state, 'client'),
        ])
        expect(readFileSync(join(root, 'cli'), 'utf8').trim().split('\n')).toEqual([
          'pull|fixture|',
          'run|--network=host|--rm|fixture|/bin/true|',
          'build|--network=host|-t|fixture|.|',
          'buildx|build|--network=host|-t|fixture|.|',
        ])
        expect(existsSync(join(root, 'stopped'))).toBe(true)
        const pid = readFileSync(join(root, 'daemon-pid'), 'utf8')
        expect(existsSync('/proc/' + pid)).toBe(false)
        expect(existsSync(join(state, 'dockerd.log'))).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('fails before packaging when its private daemon cannot start and retains diagnostics', () => {
    const { root, result, state } = fixture(0, true)
    try {
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('fixture startup failure')
      expect(existsSync(join(root, 'cli'))).toBe(false)
      expect(readFileSync(join(state, 'dockerd.log'), 'utf8')).toContain('fixture startup failure')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the pinned native packaging and archive guards behind the bounded runtime', () => {
    const workflow = readRepo('.github/workflows/kata-firecracker-extension.yaml')
    expect(workflow).toContain('--command bash devices/galactic/extensions/kata/with-job-docker.sh')
    expect(workflow).toContain('timeout-minutes: 120')
    expect(readRepo('devices/galactic/extensions/kata/shell.nix')).toContain('pkgs.docker')
    const builder = readRepo('devices/galactic/extensions/kata/build-patched-kata.sh')
    expect(builder).toContain("KATA_SOURCE_COMMIT='894e1956bb340752b30f7ad49879972234a0098c'")
    expect(builder.match(/cargo test --locked/g)).toHaveLength(3)
    expect(builder).toContain('USE_CACHE=no PUSH_TO_REGISTRY=no')
    expect(builder).toContain("grep -Fx './usr/bin/kata-agent'")
    expect(builder).toContain("grep -Fx './opt/kata/runtime-rs/bin/containerd-shim-kata-v2'")
  })
})
