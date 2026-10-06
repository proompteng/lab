import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script =
  process.env.BAYN_TEST_CAPACITY_WORKER_SCRIPT ??
  fileURLToPath(new URL('../../scripts/run-capture-capacity-worker.sh', import.meta.url))
const run = (env = {}, exits = [0, 0]) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-capacity-worker-'))
  try {
    writeFileSync(
      join(directory, 'node'),
      `#!/usr/bin/env bash
set -eu
count=0
if [[ -f "$TEST_DIRECTORY/count" ]]; then read -r count < "$TEST_DIRECTORY/count"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$TEST_DIRECTORY/count"
printf '%s\\n' "$$" "$#" "$@" >> "$TEST_DIRECTORY/calls"
if [[ "$count" == 1 ]]; then exit "$TEST_FIRST_EXIT"; fi
exit "$TEST_SECOND_EXIT"
`,
      { mode: 0o755 },
    )
    const result = spawnSync('sh', [script, 'bundle.js', 'plan.json', 'topics.json', 'execution.json', 'plan-hash'], {
      encoding: 'utf8',
      timeout: 3000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        TEST_DIRECTORY: directory,
        TEST_FIRST_EXIT: String(exits[0]),
        TEST_SECOND_EXIT: String(exits[1]),
        BAYN_TEST_CAPTURE_ATTRIBUTION: '0',
        BAYN_TEST_CAPTURE_CPU_PROFILE: '0',
        BAYN_TEST_CAPTURE_IO_DIAGNOSTICS: '0',
        BAYN_TEST_CAPTURE_ATTRIBUTION_CORPUS_HASH: 'a'.repeat(64),
        BAYN_TEST_CAPTURE_ATTRIBUTION_ANCHOR: '1791165600000',
        ...env,
      },
    })
    assert.equal(result.error, undefined)
    let lines = []
    try {
      lines = readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const calls = []
    while (lines.length) {
      const pid = lines.shift(),
        count = Number(lines.shift())
      calls.push({ pid, args: lines.splice(0, count) })
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('ordinary capacity preserves child success and failure status', () => {
  assert.equal(run().status, 0)
  assert.equal(run({}, [7, 0]).status, 7)
  assert.deepEqual(run().calls[0].args, ['bundle.js', 'plan.json', 'topics.json', 'execution.json', 'plan-hash'])
})

test('instrumented capacity can never return a qualifying status', () => {
  for (const flag of ['BAYN_TEST_CAPTURE_CPU_PROFILE', 'BAYN_TEST_CAPTURE_IO_DIAGNOSTICS']) {
    assert.equal(run({ [flag]: '1' }, [42, 0]).status, 42)
    assert.equal(run({ [flag]: '1' }, [0, 0]).status, 1)
    assert.equal(run({ [flag]: '1' }, [7, 0]).status, 7)
  }
})

test('attribution starts two fresh processes in fixed order and remains non-qualifying', () => {
  const result = run({ BAYN_TEST_CAPTURE_ATTRIBUTION: '1' }, [42, 42])
  assert.equal(result.status, 42)
  assert.equal(result.calls.length, 2)
  assert.notEqual(result.calls[0].pid, result.calls[1].pid)
  assert.deepEqual(
    result.calls.map((call) => call.args.slice(-3)),
    [
      ['full', 'a'.repeat(64), '1791165600000'],
      ['proof-light', 'a'.repeat(64), '1791165600000'],
    ],
  )
  assert.equal(JSON.parse(result.stdout).capacityQualification, false)
})

test('attribution stops on unrelated child failure or an unexpected successful status', () => {
  const first = run({ BAYN_TEST_CAPTURE_ATTRIBUTION: '1' }, [7, 42])
  assert.equal(first.status, 7)
  assert.equal(first.calls.length, 1)
  assert.equal(run({ BAYN_TEST_CAPTURE_ATTRIBUTION: '1' }, [42, 9]).status, 9)
  assert.equal(run({ BAYN_TEST_CAPTURE_ATTRIBUTION: '1' }, [0, 42]).calls.length, 1)
  assert.equal(run({ BAYN_TEST_CAPTURE_ATTRIBUTION: 'unknown' }).status, 2)
})
