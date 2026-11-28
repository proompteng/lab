import { expect, test } from 'bun:test'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cbr0Range, classifyLease, podIPsFromList, taskIDsFromList } from '../cni-cbr0-lease-audit-core'

const owner = 'a'.repeat(64)
const sandbox = 'b'.repeat(64)
const contents = `${owner}\r\neth0`
const nowMs = 1_000_000
const expiry = nowMs - 300_000
const range = cbr0Range('turin')
const podList = (items: unknown[] = [], metadata: Record<string, unknown> = { resourceVersion: '42' }) => ({
  apiVersion: 'v1',
  kind: 'PodList',
  metadata,
  items,
})
const pod = (status: Record<string, unknown>) => ({ spec: { nodeName: 'turin' }, status })

test('only an unowned lease at least 300 seconds old is an orphan', () => {
  const evidence = { range, nowMs, podIPs: new Set<string>(), taskIDs: new Set<string>() }
  const inspect = (mtimeMs: number, inputs = evidence) =>
    classifyLease({ name: '10.244.0.2', file: { mtimeMs, contents } }, inputs).status

  expect(inspect(expiry)).toBe('orphan')
  expect(inspect(expiry + 1)).toBe('too-young')
  expect(inspect(nowMs + 1)).toBe('too-young')
  expect(inspect(expiry, { ...evidence, taskIDs: new Set([owner]) })).toBe('containerd-task')
  expect(inspect(expiry, { ...evidence, podIPs: new Set(['10.244.0.2']) })).toBe('pod-ip')
})

test('only regular leases in the target node’s usable CIDR with a valid owner are eligible', () => {
  const evidence = { range, nowMs, podIPs: new Set<string>(), taskIDs: new Set<string>() }
  const inspect = (name: string, data = contents, scope = range) =>
    classifyLease({ name, file: { mtimeMs: expiry, contents: data } }, { ...evidence, range: scope }).status

  expect(range.capacity).toBe(509)
  expect(inspect('10.244.0.0')).toBe('outside-usable-range')
  expect(inspect('10.244.0.1')).toBe('outside-usable-range')
  expect(inspect('10.244.1.254', owner)).toBe('orphan') // Legacy owner-only lease.
  expect(inspect('10.244.1.255')).toBe('outside-usable-range')
  expect(inspect('10.244.4.2')).toBe('outside-usable-range')
  expect(inspect('10.244.4.2', contents, cbr0Range('talos-192-168-1-85'))).toBe('orphan')
  expect(inspect('fd00::2')).toBe('outside-usable-range')
  expect(inspect('lock')).toBe('allocator-metadata')
  expect(inspect('last_reserved_ip.0')).toBe('allocator-metadata')
  expect(inspect('notes')).toBe('unexpected-name')
  expect(inspect('10.244.0.2', 'not-a-sandbox')).toBe('invalid-lease')
  expect(inspect('10.244.0.2', `${contents}\r\nextra`)).toBe('invalid-lease')
  expect(classifyLease({ name: '10.244.0.2' }, evidence).status).toBe('unsafe-file')
})

test('PodList retains addresses from every phase and both IP fields', () => {
  const items = [
    pod({ phase: 'Pending' }),
    pod({ phase: 'Running', podIP: '10.244.0.2', podIPs: [{ ip: '10.244.0.2' }, { ip: 'fd00::2' }] }),
    pod({ phase: 'Succeeded', podIP: '10.244.0.3' }),
    pod({ phase: 'Failed', podIPs: [{ ip: '10.244.0.4' }] }),
    { ...pod({ phase: 'Unknown', podIP: '10.244.0.5' }), metadata: { deletionTimestamp: '2026-11-28T00:00:00Z' } },
  ]
  expect(podIPsFromList(podList(items), 'turin')).toEqual(
    new Set(['10.244.0.2', 'fd00::2', '10.244.0.3', '10.244.0.4', '10.244.0.5']),
  )
  expect(() => podIPsFromList(podList([], { resourceVersion: '1', continue: 'next' }), 'turin')).toThrow('complete')
  expect(() => podIPsFromList(podList([pod({ podIPs: [{}] })]), 'turin')).toThrow('Invalid IP')
  expect(() => podIPsFromList(podList(items), 'talos-192-168-1-85')).toThrow('wrong node')
  expect(taskIDsFromList(`${owner}\n${sandbox}\n`)).toEqual(new Set([owner, sandbox]))
  expect(taskIDsFromList('')).toEqual(new Set())
  expect(() => taskIDsFromList('TASK PID STATUS\n')).toThrow('one containerd task ID per line')
  expect(() => taskIDsFromList(' \n')).toThrow('one containerd task ID per line')
})

const withNode = (check: (fixture: ReturnType<typeof fakeNode>) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'cbr0-audit-'))
  try {
    check(fakeNode(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function fakeNode(root: string) {
  const bootID = '61a6cb9b-9de2-46b2-8b41-78ea75194c9a'
  const cni = join(root, 'var/lib/cni')
  const leases = join(cni, 'networks/cbr0')
  const lock = join(leases, 'lock')
  const proc = join(root, 'proc/sys/kernel/random')
  const bin = join(root, 'bin')
  for (const path of [leases, proc, bin]) mkdirSync(path, { recursive: true })
  writeFileSync(join(proc, 'boot_id'), bootID)
  writeFileSync(lock, '')
  const writeLease = (name: string, data: string, age = 600) => {
    const path = join(leases, name)
    writeFileSync(path, data, { mode: 0o600 })
    const time = Date.now() / 1000 - age
    utimesSync(path, time, time)
    return path
  }
  const node = {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: 'turin' },
    spec: { podCIDR: range.cidr, podCIDRs: [range.cidr], unschedulable: true },
    status: { nodeInfo: { bootID } },
  }
  writeFileSync(
    join(bin, 'kubectl'),
    `#!/bin/sh
set -eu
test "$2" = "test-context"
case "$6" in
  /api/v1/nodes/turin) printf '%s' "$STUB_NODE" ;;
  '/api/v1/pods?fieldSelector=spec.nodeName%3Dturin')
    if test "$STUB_ARCHIVE" = 'archive' && flock -sn "$STUB_LOCK" true; then
      exit 2
    fi
    printf '%s' "$STUB_PODS" ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o700 },
  )
  writeFileSync(
    join(bin, 'ctr'),
    `#!/bin/sh
set -eu
test "$2" = "$STUB_ROOT/run/containerd/containerd.sock"
test "$4" = "k8s.io"
test "$7 $8 $9" = "tasks list --quiet"
printf '%s' "$STUB_TASKS"
exit "$STUB_CTR_EXIT"
`,
    { mode: 0o700 },
  )
  const run = (mode?: 'archive', overrides?: Record<string, string>) =>
    Bun.spawnSync(
      [
        process.execPath,
        'run',
        join(import.meta.dir, '../cni-cbr0-lease-audit.ts'),
        '--node',
        'turin',
        '--context',
        'test-context',
        '--host-root',
        root,
        ...(mode ? ['--mode', mode] : []),
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_ROOT: root,
          STUB_LOCK: lock,
          STUB_NODE: JSON.stringify(node),
          STUB_PODS: JSON.stringify(podList()),
          STUB_TASKS: '',
          STUB_CTR_EXIT: '0',
          STUB_ARCHIVE: mode ?? '',
          ...overrides,
        },
      },
    )
  return { cni, leases, lock, node, writeLease, run }
}

const linuxTest = test.skipIf(process.platform !== 'linux')

linuxTest('dry-run changes nothing; archive rechecks ownership under lock and moves only eligible leases', () =>
  withNode(({ cni, leases, writeLease, run }) => {
    const orphan = writeLease('10.244.0.2', contents)
    const reclaimSinceDryRun = writeLease('10.244.0.3', contents)
    const task = writeLease('10.244.0.4', sandbox)
    const young = writeLease('10.244.0.5', contents, 1)
    const malformed = writeLease('10.244.0.6', 'invalid')
    const marker = writeLease('last_reserved_ip.0', '10.244.0.2')
    const link = join(leases, '10.244.0.7')
    symlinkSync(orphan, link)
    const original = statSync(orphan)

    const dryRun = run()
    expect(dryRun.exitCode).toBe(0)
    expect(JSON.parse(dryRun.stdout.toString())).toMatchObject({
      mode: 'dry-run',
      archived: [],
      results: expect.arrayContaining([{ name: '10.244.0.2', status: 'orphan', ageSeconds: expect.any(Number) }]),
    })
    expect(readdirSync(cni)).toEqual(['networks'])
    expect(existsSync(orphan)).toBeTrue()

    const archive = run('archive', {
      STUB_PODS: JSON.stringify(podList([pod({ phase: 'Succeeded', podIP: '10.244.0.3' })])),
      STUB_TASKS: `${sandbox}\n`,
    })
    expect({ exitCode: archive.exitCode, stderr: archive.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: expect.stringContaining('Archiving eligible leases'),
    })
    const report = JSON.parse(archive.stdout.toString())
    expect(report.archived).toEqual(['10.244.0.2'])
    const archived = join(report.archiveDir, '10.244.0.2')
    expect(readFileSync(archived, 'utf8')).toBe(contents)
    expect(statSync(archived)).toMatchObject({ ino: original.ino, mode: original.mode, mtimeMs: original.mtimeMs })
    expect(statSync(report.archiveDir).mode & 0o777).toBe(0o700)
    expect(existsSync(orphan)).toBeFalse()
    for (const file of [reclaimSinceDryRun, task, young, malformed, marker]) expect(existsSync(file)).toBeTrue()
    expect(readdirSync(leases)).toContain('10.244.0.7')
  }),
)

linuxTest('archive refuses incomplete evidence, a mismatched host, or an uncordoned node', () =>
  withNode(({ cni, node, writeLease, run }) => {
    const orphan = writeLease('10.244.0.2', contents)
    const badBoot = { ...node, status: { nodeInfo: { bootID: 'incorrect' } } }
    const uncordoned = { ...node, spec: { ...node.spec, unschedulable: false } }
    for (const [env, expected] of [
      [{ STUB_CTR_EXIT: '1' }, 'containerd task list failed'],
      [
        { STUB_PODS: JSON.stringify(podList([], { resourceVersion: '1', continue: 'next' })) },
        'complete core/v1 PodList',
      ],
      [{ STUB_NODE: JSON.stringify(badBoot) }, 'host boot ID'],
      [{ STUB_NODE: JSON.stringify(uncordoned) }, 'Cordon turin'],
    ] as const) {
      const result = run('archive', env)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(expected)
      expect(existsSync(orphan)).toBeTrue()
      expect(readdirSync(cni)).toEqual(['networks'])
    }
  }),
)

linuxTest('archive does not wait for or bypass a held allocator lock', () =>
  withNode(({ cni, lock, writeLease, run }) => {
    const orphan = writeLease('10.244.0.2', contents)
    const fd = openSync(lock, 'r')
    try {
      expect(Bun.spawnSync(['flock', '-xn', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).exitCode).toBe(0)
      const result = run('archive')
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain('Cannot acquire the cbr0 allocator lock')
      expect(existsSync(orphan)).toBeTrue()
      expect(readdirSync(cni)).toEqual(['networks'])
    } finally {
      closeSync(fd)
    }
  }),
)
