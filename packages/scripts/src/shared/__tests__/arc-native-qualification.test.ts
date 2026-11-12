import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const workflow = YAML.parse(readFileSync(join(repoRoot, '.github/workflows/arc-placement-acceptance.yml'), 'utf8'))
const script = join(repoRoot, 'nix/ci-arc-native-qualification.sh')
const realBash = spawnSync('which', ['bash'], { encoding: 'utf8' }).stdout.trim()
const source = 'a'.repeat(40)
const image = { digest: `sha256:${'b'.repeat(64)}`, os: 'linux', architecture: 'amd64' }
const gateScript = workflow.jobs['verify-placement'].steps.find(
  (step: { name?: string }) => step.name === 'Require thirty minutes of common native work on ten builders',
).run as string
const predicate = gateScript.match(/jq -s -e --arg source "\$EXPECTED_SOURCE" '([\s\S]*?)' native-proof/)?.[1]
if (!predicate) throw new Error('Native qualification workflow gate is missing')

const receipts = () =>
  Array.from({ length: 10 }, (_, index) => ({
    schemaVersion: 'arc.native-image-qualification.v1',
    status: 'passed',
    exitCode: 0,
    sourceRevision: source,
    packageAttr: 'bayn-image',
    role: 'build',
    slot: index + 1,
    pod: `runner-${index}`,
    node: 'turin',
    scratchFilesystem: 'ext4',
    scratchDevice: `/dev/rbd${index}`,
    nativeStart: 1000,
    nativeEnd: 3100,
    iterations: [{ iteration: 1, start: 1000, end: 3100, rebuild: true, exitCode: 0, image }],
  }))

describe('ARC native image qualification', () => {
  it('keeps native work opt-in and preserves bounded jobs and failure artifacts', () => {
    expect(workflow.on.workflow_dispatch.inputs.native_qualification).toMatchObject({ type: 'boolean', default: false })
    const job = workflow.jobs['ceph-build']
    expect(job['timeout-minutes']).toBe('${{ inputs.native_qualification && 110 || 20 }}')
    const nativeSteps = job.steps.filter((step: { name?: string }) => /native/i.test(step.name ?? ''))
    expect(nativeSteps.length).toBe(7)
    for (const step of nativeSteps) expect(step.if).toContain('inputs.native_qualification')
    expect(nativeSteps.at(-1).if).toContain('always()')
    expect(nativeSteps.at(-1).with.path).toContain('arc-native/*.tsv')
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(readFileSync(script, 'utf8')).not.toMatch(/oci-push|cache-push|ATTIC_TOKEN|kubectl|kargo-sha/)
  })

  it.each([
    [
      'passes the exact common-window boundary',
      (data: ReturnType<typeof receipts>) => {
        data[9].nativeStart += 300
        data[9].nativeEnd += 300
        data[9].iterations[0].start += 300
        data[9].iterations[0].end += 300
      },
      true,
    ],
    [
      'rejects a late native participant',
      (data: ReturnType<typeof receipts>) => {
        data[9].nativeStart += 301
        data[9].nativeEnd += 301
        data[9].iterations[0].start += 301
        data[9].iterations[0].end += 301
      },
      false,
    ],
    [
      'rejects a short native window',
      (data: ReturnType<typeof receipts>) => {
        data[0].nativeEnd -= 1
        data[0].iterations[0].end -= 1
      },
      false,
    ],
    [
      'rejects a missing participant',
      (data: ReturnType<typeof receipts>) => {
        data.pop()
      },
      false,
    ],
    [
      'rejects a failed job',
      (data: ReturnType<typeof receipts>) => {
        data[0].status = 'failed'
      },
      false,
    ],
    [
      'rejects a failed iteration',
      (data: ReturnType<typeof receipts>) => {
        data[0].iterations[0].exitCode = 124
      },
      false,
    ],
    [
      'rejects an unforced cache hit',
      (data: ReturnType<typeof receipts>) => {
        data[0].iterations[0].rebuild = false
      },
      false,
    ],
    [
      'rejects a fabricated hold after work',
      (data: ReturnType<typeof receipts>) => {
        data[0].nativeEnd += 1800
      },
      false,
    ],
    [
      'rejects a different source',
      (data: ReturnType<typeof receipts>) => {
        data[0].sourceRevision = 'c'.repeat(40)
      },
      false,
    ],
    [
      'rejects a reused pod',
      (data: ReturnType<typeof receipts>) => {
        data[0].pod = data[1].pod
      },
      false,
    ],
    [
      'rejects a reused scratch device',
      (data: ReturnType<typeof receipts>) => {
        data[0].scratchDevice = data[1].scratchDevice
      },
      false,
    ],
  ] as const)('%s', (_name, mutate, accepted) => {
    const data = receipts()
    mutate(data)
    const result = spawnSync('jq', ['-s', '-e', '--arg', 'source', source, predicate], {
      input: data.map((receipt) => JSON.stringify(receipt)).join('\n'),
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(accepted ? 0 : 5)
  })

  const withIntervals = (data: ReturnType<typeof receipts>, index: number, intervals: [number, number][]) => {
    data[index].iterations = intervals.map(([start, end], ordinal) => ({
      iteration: ordinal + 1,
      start,
      end,
      rebuild: true,
      exitCode: 0,
      image,
    }))
  }

  it.each([
    [
      'rejects sparse work hidden by a long wall window',
      (data: ReturnType<typeof receipts>) => {
        for (let index = 0; index < 10; index += 1)
          withIntervals(data, index, [
            [1000, 1001],
            [3099, 3100],
          ])
      },
    ],
    [
      'rejects overlapping intervals',
      (data: ReturnType<typeof receipts>) => {
        withIntervals(data, 0, [
          [1000, 2000],
          [1900, 3100],
        ])
      },
    ],
    [
      'rejects reversed middle intervals',
      (data: ReturnType<typeof receipts>) => {
        withIntervals(data, 0, [
          [1000, 1200],
          [1700, 1800],
          [1300, 1500],
          [2000, 3100],
        ])
      },
    ],
    [
      'rejects individually long windows with insufficient shared work',
      (data: ReturnType<typeof receipts>) => {
        withIntervals(data, 0, [
          [1000, 1500],
          [1700, 3100],
        ])
        withIntervals(data, 1, [
          [1000, 2000],
          [2200, 3100],
        ])
      },
    ],
  ] as const)('%s', (_name, mutate) => {
    const data = receipts()
    mutate(data)
    const result = spawnSync('jq', ['-s', '-e', '--arg', 'source', source, predicate], {
      input: data.map((receipt) => JSON.stringify(receipt)).join('\n'),
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(5)
  })

  it('reports the exact shared work after subtracting the union of runner gaps', () => {
    const data = receipts()
    withIntervals(data, 0, [
      [1000, 1600],
      [1700, 3100],
    ])
    withIntervals(data, 1, [
      [1000, 1650],
      [1750, 3100],
    ])
    withIntervals(data, 2, [
      [1000, 2000],
      [2000, 3100],
    ])
    const result = spawnSync('jq', ['-s', '-e', '--arg', 'source', source, predicate], {
      input: data.map((receipt) => JSON.stringify(receipt)).join('\n'),
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      commonStart: 1000,
      commonEnd: 3100,
      commonNativeWorkSeconds: 1950,
    })
  })

  it.each([
    { name: 'records only forced, inspected iterations after preparation', phase: '', code: 0 },
    { name: 'retains a preparation failure', phase: 'realize', code: 42 },
    { name: 'retains a rebuild timeout', phase: 'rebuild-1', code: 124 },
    { name: 'retains an archive inspection failure', phase: 'inspect-1', code: 43 },
    { name: 'retains an image command verification failure', phase: 'verify-1', code: 44 },
    { name: 'stops before a command when the work budget expires', phase: 'budget', code: 124 },
    { name: 'caps a command to the remaining work budget', phase: 'remaining-budget', code: 124 },
  ])(
    '$name',
    ({ phase, code }) => {
      const directory = mkdtempSync(join(tmpdir(), 'arc-native-test-'))
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      mkdirSync(join(directory, 'arc-native'))
      writeFileSync(
        join(directory, 'arc-native/budget.json'),
        JSON.stringify({ workDeadline: phase === 'budget' ? 1000 : phase === 'remaining-budget' ? 2000 : 1000000 }),
      )
      const executable = (name: string, body: string) =>
        writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
      writeFileSync(join(directory, 'arc-ready.json'), JSON.stringify(receipts()[0]))
      writeFileSync(join(directory, 'image.tar'), 'test image archive')
      executable('git', 'printf "%s\\n" "$MOCK_SOURCE"')
      executable('gh', 'printf "10\\n"')
      executable(
        'date',
        'clock=1000\nif [ -f "$MOCK_CLOCK" ]; then clock=$(cat "$MOCK_CLOCK"); fi\nclock=$((clock + 400))\nprintf "%s\\n" "$clock" > "$MOCK_CLOCK"\nprintf "%s\\n" "$clock"',
      )
      executable('timeout', 'printf "%s\\n" "$*" >> "$MOCK_TIMEOUTS"\nshift 2\nexec "$@"')
      executable(
        'nix',
        'printf "%s\\n" "$*" >> "$MOCK_CALLS"\nfor arg do\n  if [ "$arg" = --rebuild ]; then exit "$MOCK_REBUILD_EXIT"; fi\ndone\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --out-link ]; then ln -s "$MOCK_IMAGE" "$2"; break; fi\n  shift\ndone\nexit "$MOCK_REALIZE_EXIT"',
      )
      executable(
        'bash',
        `case "$1" in
  nix/oci-inspect-archive.sh) printf '%s\\n' '${JSON.stringify(image)}'; exit "$MOCK_INSPECT_EXIT" ;;
  nix/verify-bayn-image-command.sh) exit "$MOCK_VERIFY_EXIT" ;;
  *) exec "$REAL_BASH" "$@" ;;
esac`,
      )
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        REAL_BASH: realBash,
        GH_REPO: 'proompteng/lab',
        RUN_ID: '1',
        RUN_ATTEMPT: '1',
        MOCK_SOURCE: source,
        MOCK_IMAGE: join(directory, 'image.tar'),
        MOCK_CLOCK: join(directory, 'clock'),
        MOCK_CALLS: join(directory, 'calls'),
        MOCK_TIMEOUTS: join(directory, 'timeouts'),
        MOCK_REALIZE_EXIT: phase === 'realize' ? String(code) : '0',
        MOCK_REBUILD_EXIT: '0',
        MOCK_INSPECT_EXIT: '0',
        MOCK_VERIFY_EXIT: '0',
      }
      try {
        const prepared = spawnSync(realBash, [script, 'prepare'], {
          cwd: repoRoot,
          env,
          encoding: 'utf8',
          timeout: 10000,
        })
        expect(prepared.status, prepared.stderr).toBe(
          phase === 'realize' || phase === 'budget' || phase === 'remaining-budget' ? code : 0,
        )
        let result = prepared
        if (prepared.status === 0) {
          const seed = JSON.parse(readFileSync(join(directory, 'arc-native/receipt.json'), 'utf8'))
          expect(seed.status).toBe('prepared')
          expect(seed.nativeStart).toBeNull()
          expect(seed.iterations).toEqual([])
          result = spawnSync(realBash, [script, 'qualify'], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
            env: {
              ...env,
              MOCK_REBUILD_EXIT: phase === 'rebuild-1' ? String(code) : '0',
              MOCK_INSPECT_EXIT: phase === 'inspect-1' ? String(code) : '0',
              MOCK_VERIFY_EXIT: phase === 'verify-1' ? String(code) : '0',
            },
          })
        }
        expect(result.status, result.stderr).toBe(code)
        const receipt = JSON.parse(readFileSync(join(directory, 'arc-native/receipt.json'), 'utf8'))
        expect(receipt.status).toBe(code === 0 ? 'passed' : 'failed')
        expect(receipt.exitCode).toBe(code)
        const timings = readFileSync(join(directory, 'arc-native/timings.tsv'), 'utf8')
        if (code === 0) {
          expect(receipt.iterations).toHaveLength(1)
          expect(receipt.iterations[0]).toMatchObject({ rebuild: true, exitCode: 0, image })
          expect(receipt.nativeStart).toBe(receipt.iterations[0].start)
          expect(receipt.nativeEnd - receipt.nativeStart).toBeGreaterThanOrEqual(2100)
          expect(timings).toContain('rebuild-1\t0\t')
          expect(timings).toContain('inspect-1\t0\t')
          expect(timings).toContain('verify-1\t0\t')
          expect(readFileSync(join(directory, 'calls'), 'utf8')).toContain(
            'build .#bayn-image --rebuild --print-build-logs',
          )
          expect(readFileSync(join(directory, 'timeouts'), 'utf8')).toContain('--kill-after=30s 2700s nix build')
          expect(readFileSync(join(directory, 'timeouts'), 'utf8')).toContain(
            '--kill-after=30s 300s bash nix/oci-inspect-archive.sh',
          )
        } else {
          expect(receipt.iterations).toEqual([])
          const failedPhase = phase === 'budget' ? 'realize' : phase === 'remaining-budget' ? 'inspect-seed' : phase
          expect(receipt.phase).toBe(failedPhase)
          expect(timings).toContain(`${failedPhase}\t${code}\t`)
          if (phase === 'remaining-budget') {
            expect(readFileSync(join(directory, 'timeouts'), 'utf8')).toContain('--kill-after=30s 570s nix build')
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30000,
  )
})
