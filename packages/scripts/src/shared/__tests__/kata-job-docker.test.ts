import { spawn, spawnSync } from 'node:child_process'
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
const podCgroup = '/kubepods/burstable/pod-fixture'
const leafCgroup = podCgroup + '/runner'
type FixtureOptions = {
  exitCode?: number
  commands?: string[]
  failStartup?: boolean
  cgroup?: string
  memory?: string
  cpu?: string
  controllers?: string
  processes?: string
  filesystem?: string
  foreignPid?: boolean
  stalePid?: boolean
  replacePidAfterReady?: boolean
  escapedDaemon?: boolean
  badContainerd?: 'root' | 'state' | 'address' | 'socket'
  systemContainerd?: boolean
}

const fixture = (options: FixtureOptions = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'kata-job-runtime-'))
  const bin = join(root, 'bin')
  const runnerTemp = join(root, 'runner-temp')
  const cgroupRoot = join(root, 'cgroup')
  const systemSocket = join(root, 'system-containerd.sock')
  mkdirSync(bin)
  mkdirSync(runnerTemp)
  chmodSync(runnerTemp, 0o2770)
  mkdirSync(cgroupRoot + leafCgroup, { recursive: true })
  for (const [name, value] of Object.entries({
    'memory.max': options.memory ?? '34359738368',
    'cpu.max': options.cpu ?? '2000000 100000',
    'cgroup.subtree_control': options.controllers ?? 'cpuset cpu io memory pids',
    'cgroup.procs': options.processes ?? '',
  })) {
    writeFileSync(join(cgroupRoot + podCgroup, name), value + '\n')
  }
  writeFileSync(join(cgroupRoot + leafCgroup, 'memory.max'), '34359738368\n')
  writeFileSync(join(cgroupRoot + leafCgroup, 'cpu.max'), '2000000 100000\n')
  if (options.systemContainerd) writeFileSync(systemSocket, '')
  writeFileSync(join(root, 'self-cgroup'), '0::' + (options.cgroup ?? leafCgroup) + '\n')
  writeFileSync(join(root, 'daemon-cgroup'), '0::' + (options.escapedDaemon ? '/unrelated/daemon' : leafCgroup) + '\n')
  // Remap only immutable read paths, retaining production guards and real
  // process identity/signals. These fixtures add no production override.
  const fixtureWrapper = join(root, 'wrapper.sh')
  writeFileSync(
    fixtureWrapper,
    readFileSync(wrapper, 'utf8')
      .replaceAll('/sys/fs/cgroup', cgroupRoot)
      .replaceAll('/proc/self/cgroup', join(root, 'self-cgroup'))
      .replaceAll('/proc/$daemon_pid/cgroup', join(root, 'daemon-cgroup'))
      .replaceAll('/run/containerd/containerd.sock', systemSocket),
  )
  const real = (name: string) =>
    spawnSync('bash', ['-c', 'command -v "$1"', '--', name], { encoding: 'utf8' }).stdout.trim()
  const executable = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), ['#!/usr/bin/env bash', 'set -euo pipefail', ...lines, ''].join('\n'), {
      mode: 0o755,
    })
  }
  executable('sudo', ['[[ "$1" == -n ]] && shift', 'export FIXTURE_ELEVATED=1', 'exec "$@"'])
  executable('readlink', [
    'for last; do :; done',
    'if [[ "$last" == /proc/*/exe ]]; then',
    '  [[ "$FIXTURE_ELEVATED" == 1 ]] || { echo "fixture: root process exe requires sudo" >&2; exit 1; }',
    '  printf "%s\\n" "$last" >> "$FIXTURE_ROOT/elevated-proc-reads"',
    'fi',
    'exec "$REAL_READLINK" "$@"',
  ])
  executable('stat', [
    'if [[ "$*" == "-f -c %T "* ]]; then printf "%s\\n" "$CGROUP_FILESYSTEM"; exit 0; fi',
    'exec "$REAL_STAT" "$@"',
  ])
  executable('dockerd', [
    'printf "%s\\n" "$@" > "$FIXTURE_ROOT/daemon-args"',
    'printf "%s" "$DOCKER_TMPDIR" > "$FIXTURE_ROOT/daemon-tmp"',
    'if [[ "$FAIL_STARTUP" == 1 ]]; then echo "fixture startup failure"; exit 9; fi',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    --pidfile) pidfile="$2"; shift 2 ;;',
    '    --data-root) data_root="$2"; shift 2 ;;',
    '    --exec-root) exec_root="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'recorded_pid="$PIDFILE_VALUE"; [[ -n "$recorded_pid" ]] || recorded_pid="$$"',
    'printf "%s" "$recorded_pid" > "$pidfile"',
    'printf "%s" "$pidfile" > "$FIXTURE_ROOT/pidfile-path"',
    'printf "%s" "$$" > "$FIXTURE_ROOT/daemon-pid"',
    'python3 - "$data_root" "$exec_root" "$BAD_CONTAINERD" <<\'PY\'',
    'import json, pathlib, socket, sys',
    'data, execution, bad = sys.argv[1:]',
    'directory = pathlib.Path(execution) / "containerd"',
    'directory.mkdir(parents=True)',
    'address = str(directory / "containerd.sock")',
    'root = data + "/containerd/daemon" + ("/outside" if bad == "root" else "")',
    'state = execution + "/containerd/daemon" + ("/outside" if bad == "state" else "")',
    'configured_address = address + (".outside" if bad == "address" else "")',
    '(directory / "containerd.toml").write_text("root = " + json.dumps(root) + "\\nstate = " + json.dumps(state) + "\\n[grpc]\\naddress = " + json.dumps(configured_address) + "\\n")',
    'if bad == "socket":',
    '    pathlib.Path(address).write_text("not a socket")',
    'else:',
    '    endpoint = socket.socket(socket.AF_UNIX)',
    '    endpoint.bind(address)',
    '    endpoint.close()',
    'PY',
    'printf "%s" "$data_root" > "$FIXTURE_ROOT/daemon-root"',
    'trap \'echo stopped > "$FIXTURE_ROOT/stopped"; exit 0\' TERM',
    'while :; do sleep 0.05; done',
  ])
  executable('docker', [
    '[[ "$1" == --host && "$3" == --config ]] || exit 18',
    'selected_host="$2"; selected_config="$4"; shift 4',
    'if [[ "$1" == info ]]; then',
    '  for last; do :; done',
    '  case "$last" in',
    '    "{{.DockerRootDir}}") "$REAL_CAT" "$FIXTURE_ROOT/daemon-root" ;;',
    '    "{{.CgroupDriver}}:{{.CgroupVersion}}") echo cgroupfs:2 ;;',
    '    *) exit 17 ;;',
    '  esac',
    '  exit 0',
    'fi',
    'printf "%s|" "$@" >> "$FIXTURE_ROOT/cli"',
    'printf "\\n" >> "$FIXTURE_ROOT/cli"',
    'printf "%s\\n" "$selected_host" "$selected_config" > "$FIXTURE_ROOT/client-paths"',
    'if env | grep -E "^(DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDX_BUILDER|BUILDKIT_HOST)="; then exit 19; fi',
  ])
  const outsider =
    options.foreignPid || options.replacePidAfterReady ? spawn('sleep', ['60'], { stdio: 'ignore' }) : null
  const payload = [
    'if [[ "$REPLACE_PID" == 1 ]]; then printf "%s" "$OUTSIDER_PID" > "$(cat "$FIXTURE_ROOT/pidfile-path")"; fi',
    'export DOCKER_HOST=unix:///foreign.sock DOCKER_CONFIG=/foreign/config DOCKER_CONTEXT=foreign BUILDX_BUILDER=foreign',
    (
      options.commands ?? [
        'docker pull fixture',
        'docker run --rm fixture /bin/true',
        'docker build -t fixture .',
        'docker buildx build -t fixture .',
      ]
    ).join(' && ') + ' || exit "$?"',
    'exit "$PAYLOAD_EXIT"',
  ].join('\n')
  const result = spawnSync('bash', [fixtureWrapper, 'bash', '-c', payload], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      RUNNER_TEMP: runnerTemp,
      FIXTURE_ROOT: root,
      FIXTURE_ELEVATED: '0',
      PAYLOAD_EXIT: String(options.exitCode ?? 0),
      FAIL_STARTUP: options.failStartup ? '1' : '0',
      CGROUP_FILESYSTEM: options.filesystem ?? 'cgroup2fs',
      BAD_CONTAINERD: options.badContainerd ?? '',
      PIDFILE_VALUE: options.foreignPid ? String(outsider?.pid) : options.stalePid ? '2147483647' : '',
      OUTSIDER_PID: String(outsider?.pid ?? ''),
      REPLACE_PID: options.replacePidAfterReady ? '1' : '0',
      REAL_READLINK: real('readlink'),
      REAL_CAT: real('cat'),
      REAL_STAT: real('stat'),
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      DOCKER_CONTEXT: 'unrelated-context',
      DOCKER_TLS_VERIFY: '1',
      BUILDKIT_HOST: 'unix:///unrelated-buildkit.sock',
    },
  })
  const state = join(runnerTemp, readdirSync(runnerTemp)[0] ?? 'missing')
  const cleanup = () => {
    outsider?.kill('SIGTERM')
    const pidPath = join(root, 'daemon-pid')
    if (existsSync(pidPath)) {
      try {
        process.kill(Number(readFileSync(pidPath, 'utf8')), 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
  return { root, runnerTemp, result, state, outsider, cleanup }
}

describe('Kata job-owned Docker runtime', () => {
  for (const exitCode of [0, 7]) {
    it('isolates bounded runtime storage and preserves command status ' + exitCode, () => {
      const { root, runnerTemp, result, state, cleanup } = fixture({ exitCode })
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
          ['--cgroup-parent', podCgroup],
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
          'run|--network=host|--cgroup-parent=' + podCgroup + '|--rm|fixture|/bin/true|',
          'build|--network=host|--cgroup-parent=' + podCgroup + '|-t|fixture|.|',
          'buildx|build|--network=host|--cgroup-parent=' + podCgroup + '|-t|fixture|.|',
        ])
        expect(result.stdout).toContain('Verified private containerd configuration and socket')
        expect(existsSync(join(root, 'elevated-proc-reads'))).toBe(true)
        expect(existsSync(join(root, 'stopped'))).toBe(true)
        const pid = readFileSync(join(root, 'daemon-pid'), 'utf8')
        expect(existsSync('/proc/' + pid)).toBe(false)
        expect(existsSync(join(state, 'dockerd.log'))).toBe(true)
      } finally {
        cleanup()
      }
    })
  }

  it('preserves upstream host-network options without injecting duplicates', () => {
    const commands = [
      'docker run --net=host --rm fixture /bin/true',
      'docker run --net host --rm fixture /bin/true',
      'docker run --network=host --rm fixture /bin/true',
      'docker run --network host --rm fixture /bin/true',
      'docker build --network=host -t fixture .',
      'docker buildx build --network host -t fixture .',
    ]
    const { root, result, cleanup } = fixture({ commands })
    try {
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(readFileSync(join(root, 'cli'), 'utf8').trim().split('\n')).toEqual([
        'run|--cgroup-parent=' + podCgroup + '|--net=host|--rm|fixture|/bin/true|',
        'run|--cgroup-parent=' + podCgroup + '|--net|host|--rm|fixture|/bin/true|',
        'run|--cgroup-parent=' + podCgroup + '|--network=host|--rm|fixture|/bin/true|',
        'run|--cgroup-parent=' + podCgroup + '|--network|host|--rm|fixture|/bin/true|',
        'build|--cgroup-parent=' + podCgroup + '|--network=host|-t|fixture|.|',
        'buildx|build|--cgroup-parent=' + podCgroup + '|--network|host|-t|fixture|.|',
      ])
    } finally {
      cleanup()
    }
  })

  for (const command of [
    'docker run --net=bridge fixture /bin/true',
    'docker build --network none .',
    'docker buildx build --network=bridge .',
  ]) {
    it('rejects conflicting upstream network mode: ' + command, () => {
      const { root, result, cleanup } = fixture({ commands: [command] })
      try {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('requires host networking inside its Pod')
        expect(existsSync(join(root, 'cli'))).toBe(false)
      } finally {
        cleanup()
      }
    })
  }

  it('fails before packaging when its private daemon cannot start and retains diagnostics', () => {
    const { root, result, state, cleanup } = fixture({ failStartup: true })
    try {
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('fixture startup failure')
      expect(existsSync(join(root, 'cli'))).toBe(false)
      expect(readFileSync(join(state, 'dockerd.log'), 'utf8')).toContain('fixture startup failure')
    } finally {
      cleanup()
    }
  })

  for (const [name, options] of [
    ['root cgroup', { cgroup: '/' }],
    ['foreign hierarchy', { cgroup: '/unrelated/leaf' }],
    ['unbounded memory', { memory: 'max' }],
    ['unbounded CPU', { cpu: 'max 100000' }],
    ['parent exceeds runner memory', { memory: '68719476736' }],
    ['parent exceeds runner CPU', { cpu: '4000000 100000' }],
    ['missing CPU delegation', { controllers: 'memory' }],
    ['parent has direct processes', { processes: '123' }],
    ['wrong filesystem', { filesystem: 'ext2/ext3' }],
    ['existing system containerd', { systemContainerd: true }],
  ] satisfies [string, FixtureOptions][]) {
    it('rejects ' + name + ' before starting a daemon', () => {
      const { root, result, cleanup } = fixture(options)
      try {
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(existsSync(join(root, 'daemon-args'))).toBe(false)
        expect(existsSync(join(root, 'cli'))).toBe(false)
      } finally {
        cleanup()
      }
    })
  }

  for (const [name, options] of [
    ['foreign live PID', { foreignPid: true }],
    ['stale PID', { stalePid: true }],
  ] satisfies [string, FixtureOptions][]) {
    it('rejects a ' + name + ' without signalling another process', () => {
      const { root, result, outsider, cleanup } = fixture(options)
      try {
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('PID does not identify this job runtime')
        expect(existsSync(join(root, 'cli'))).toBe(false)
        if (outsider?.pid) {
          expect(existsSync('/proc/' + outsider.pid)).toBe(true)
          expect(
            readFileSync('/proc/' + outsider.pid + '/stat', 'utf8')
              .split(') ')
              .at(-1)
              ?.split(' ')[0],
          ).not.toBe('Z')
        }
      } finally {
        cleanup()
      }
    })
  }

  it('keeps its captured daemon identity after the PID file is replaced', () => {
    const { root, result, outsider, cleanup } = fixture({ replacePidAfterReady: true })
    try {
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(existsSync(join(root, 'stopped'))).toBe(true)
      expect(existsSync('/proc/' + outsider?.pid)).toBe(true)
      expect(
        readFileSync('/proc/' + outsider?.pid + '/stat', 'utf8')
          .split(') ')
          .at(-1)
          ?.split(' ')[0],
      ).not.toBe('Z')
      expect(existsSync('/proc/' + readFileSync(join(root, 'daemon-pid'), 'utf8'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  for (const options of [
    { escapedDaemon: true },
    { badContainerd: 'root' },
    { badContainerd: 'state' },
    { badContainerd: 'address' },
    { badContainerd: 'socket' },
  ] satisfies FixtureOptions[]) {
    it('rejects escaped runtime receipt ' + JSON.stringify(options), () => {
      const { root, result, cleanup } = fixture(options)
      try {
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(existsSync(join(root, 'cli'))).toBe(false)
        expect(existsSync(join(root, 'stopped'))).toBe(true)
      } finally {
        cleanup()
      }
    })
  }

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
