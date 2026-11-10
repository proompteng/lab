import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../operations/unify-native-arrivals/copy.sh', import.meta.url))
const mockPsql = `#!/usr/bin/env bash
set -euo pipefail
[[ "$PGSSLMODE" == verify-full && "$PGSSLROOTCERT" == "/certs/$PGHOST/ca.crt" ]] || exit 90
sql="\${!#}"
phase=unknown
value=''
case "$sql" in
  'SHOW default_transaction_read_only') phase=fence; value=on ;;
  'SHOW transaction_read_only') phase=writable; value=off ;;
  'SELECT capture_id FROM native_arrival_epochs ORDER BY capture_id') phase=inventory; value=$(printf '%064d' 1) ;;
  'SELECT count(*) FROM native_arrival_epochs') phase=inventory-count; value=1 ;;
  *'FROM native_arrival_epochs WHERE'*)
    count=0
    [[ ! -f "$MOCK_STATE/$PGHOST-epoch" ]] || read -r count < "$MOCK_STATE/$PGHOST-epoch"
    count=$((count + 1))
    echo "$count" > "$MOCK_STATE/$PGHOST-epoch"
    phase=epoch-$count; value=epoch-hash ;;
  'SELECT coalesce(max(ordinal),-1)'*)
    phase=last; value=0
    [[ "$PGHOST" != target || "$COPY_CHUNKS" != 1 ]] || value=-1 ;;
  'SELECT content_hash FROM native_arrival_chunks'*) phase=prefix; value=prefix-hash ;;
  'COPY (SELECT capture_id,ordinal,'*) phase=copy; value=binary-fixture ;;
  'COPY native_arrival_chunks '*) phase=copy; cat >/dev/null ;;
  'SELECT count(*) ||'*) phase=manifest; value=1:0:manifest-hash ;;
  *'FROM native_arrival_ends WHERE'*)
    count=0
    [[ ! -f "$MOCK_STATE/$PGHOST-end" ]] || read -r count < "$MOCK_STATE/$PGHOST-end"
    count=$((count + 1))
    echo "$count" > "$MOCK_STATE/$PGHOST-end"
    phase=end-$count ;;
  *) echo 'Unexpected fixture query' >&2; exit 91 ;;
esac
echo "$PGHOST:$phase" >> "$MOCK_STATE/calls"
[[ "$MISMATCH" != "$PGHOST:$phase" ]] || value=different-hash
if [[ ",$FAIL_READS," == *",$PGHOST:$phase,"* ]]; then
  [[ "$FAIL_OUTPUT" != value ]] || printf '%s\\n' "$value"
  echo 'fixture connection failed' >&2
  exit 2
fi
printf '%s\\n' "$value"
`

const runCopy = (options: { fail?: string; failOutput?: string; mismatch?: string; copy?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-copy-test-'))
  try {
    writeFileSync(join(directory, 'psql'), mockPsql, { mode: 0o755 })
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        MOCK_STATE: directory,
        SOURCE_HOST: 'source',
        TARGET_HOST: 'target',
        SOURCE_DATABASE: 'fixture',
        TARGET_DATABASE: 'fixture',
        SOURCE_USER: 'fixture',
        TARGET_USER: 'fixture',
        SOURCE_PASSWORD: 'fixture',
        TARGET_PASSWORD: 'fixture',
        FAIL_READS: options.fail ?? '',
        FAIL_OUTPUT: options.failOutput ?? 'empty',
        MISMATCH: options.mismatch ?? '',
        COPY_CHUNKS: options.copy ? '1' : '0',
      },
    })
    return { ...result, calls: readFileSync(join(directory, 'calls'), 'utf8') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('copy verifies an existing immutable prefix and leaves absent endings absent', () => {
  const result = runCopy()
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('All source epochs, compressed chunks, ordered prefixes and endings verified')
  expect(result.calls).not.toContain(':copy')
})

test('copy resumes missing chunks through the existing pipeline', () => {
  const result = runCopy({ copy: true })
  expect(result.status).toBe(0)
  expect(result.calls).toContain('source:copy')
  expect(result.calls).toContain('target:copy')
})

for (const phase of [
  'source:fence',
  'target:writable',
  'source:inventory',
  'source:epoch-1',
  'target:epoch-1',
  'target:last',
  'source:last',
  'source:prefix',
  'target:prefix',
  'source:manifest',
  'target:manifest',
  'target:epoch-2',
  'source:end-1',
  'target:end-1',
  'target:end-2',
  'source:inventory-count',
]) {
  test(`copy rejects failed ${phase} even when stdout contains the expected value`, () => {
    const result = runCopy({ fail: phase, failOutput: 'value' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('read failed')
    expect(result.stdout).not.toContain('All source epochs')
    if (phase === 'source:inventory') expect(result.calls).not.toContain('source:epoch-1')
  })
}

for (const phase of ['prefix', 'manifest', 'end-1']) {
  test(`paired ${phase} read failures cannot compare as equal empty strings`, () => {
    const result = runCopy({ fail: `source:${phase},target:${phase}` })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('read failed')
    expect(result.stderr).not.toContain('differs')
    expect(result.stdout).not.toContain('All source epochs')
  })
}

for (const phase of ['prefix', 'manifest', 'epoch-2', 'end-2']) {
  test(`successful ${phase} reads still reject a genuine mismatch`, () => {
    const result = runCopy({ mismatch: `target:${phase}` })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('differs')
    expect(result.stdout).not.toContain('All source epochs')
  })
}

for (const side of ['source', 'target']) {
  test(`copy stops after a failed ${side} COPY without claiming verification`, () => {
    const result = runCopy({ fail: `${side}:copy`, copy: true })
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('All source epochs')
    expect(result.calls).not.toContain(':manifest')
  })
}
