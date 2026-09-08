import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const validator = resolve(import.meta.dir, 'validate-primitives.sh')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

test('is an executable, read-only validator for the current Agents contract', async () => {
  const source = await readFile(validator, 'utf8')
  const mode = await stat(validator)

  expect(mode.mode & 0o111).not.toBe(0)
  expect(source).toContain('set -euo pipefail')
  expect(source).toContain('AGENTS_DB_CLUSTER="${AGENTS_DB_CLUSTER:-agents-db-next}"')
  expect(source).toContain('MEMORY_SCHEMA="${MEMORY_SCHEMA:-public}"')
  expect(source).toContain('memories.agents.proompteng.ai')
  expect(source).toContain('orchestrationruns.orchestration.proompteng.ai')
  expect(source).toContain('--set=memory_dataset=')
  expect(source).toContain('kubectl cnpg version --namespace')
  expect(source).toContain('kubectl cnpg psql --namespace')
  expect(source).not.toMatch(/kubectl --namespace[^\n]+cnpg/)
  expect(source).not.toContain('jangar_primitives')
  expect(source).not.toContain('facteur-vector-cluster')
  expect(source).not.toContain('/v1/orchestration-executions')
  expect(source).not.toMatch(/kubectl[^\n]*(?:apply|create|patch|delete)/i)
})

test('validates a representative Agents and Memory provider fixture without writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jangar-primitives-'))
  cleanups.push(() => rm(root, { force: true, recursive: true }))

  const bin = join(root, 'bin')
  const log = join(root, 'kubectl-args')
  const fakeKubectl = join(bin, 'kubectl')
  await mkdir(bin, { recursive: true })
  await writeFile(
    fakeKubectl,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$FAKE_KUBECTL_LOG"
printf '\n' >> "$FAKE_KUBECTL_LOG"

if [[ "$*" == *"cnpg version"* ]]; then
  exit 0
fi

if [[ "$*" == *"get memories.agents.proompteng.ai agents-primitives"* ]]; then
  printf '%s\n' '{"metadata":{"name":"agents-primitives","namespace":"agents"},"spec":{"type":"postgres","connection":{"secretRef":{"name":"agents-db-app","key":"uri"}}},"status":{"conditions":[{"type":"Ready","status":"True"}]}}'
  exit 0
fi

if [[ "$*" == *"get orchestrationruns.orchestration.proompteng.ai"* ]]; then
if [[ "${'$'}{FAKE_SUCCEEDED_RUN:-1}" == "1" ]]; then
    printf '%s\n' '{"items":[{"metadata":{"name":"smoke-run"},"status":{"phase":"Succeeded","stepStatuses":[{"name":"step","phase":"Succeeded"}]}}]}'
  else
    printf '%s\n' '{"items":[]}'
  fi
  exit 0
fi

if [[ "$*" == *"cnpg psql"* ]]; then
  if [[ "$*" == *"pg_catalog.pg_extension"* ]]; then
    printf 'pgcrypto\nvector\n'
  elif [[ "$*" == *"agent_runs"* ]]; then
    printf 'agents_control_plane.resources_current\nmemories.entries\npublic.agent_run_idempotency_keys\npublic.agent_runs\npublic.audit_events\npublic.memory_resources\npublic.orchestration_runs\n'
  elif [[ "$*" == *"pg_catalog.pg_class"* && "$*" == *"memory_events"* ]]; then
    printf 'public.memory_embeddings\npublic.memory_events\npublic.memory_kv\n'
  elif [[ "$*" == *"SELECT count"* ]]; then
    printf '%s\n' "${'$'}{FAKE_MEMORY_COUNT:-1}"
  else
    echo "unexpected cnpg query: $*" >&2
    exit 1
  fi
  exit 0
fi

echo "unexpected kubectl call: $*" >&2
exit 1
`,
    'utf8',
  )
  await chmod(fakeKubectl, 0o755)

  const result = Bun.spawnSync(['/bin/bash', validator, '--require-memory-data', '--require-succeeded-run'], {
    env: {
      ...process.env,
      FAKE_KUBECTL_LOG: log,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  const output = new TextDecoder().decode(result.stdout)
  expect(output).toContain('Validation complete (read-only).')
  expect(output).toContain('Validated succeeded orchestration run: smoke-run')

  const kubectlCalls = (await readFile(log, 'utf8')).trim().split('\n')
  expect(kubectlCalls.length).toBeGreaterThan(0)
  for (const call of kubectlCalls) {
    expect(call).toContain('--namespace')
    if (call.includes('cnpg')) expect(call).toMatch(/^cnpg (?:version|psql) --namespace /)
  }

  const uppercaseMemoryGate = Bun.spawnSync(['/bin/bash', validator], {
    env: {
      ...process.env,
      FAKE_KUBECTL_LOG: log,
      FAKE_MEMORY_COUNT: '0',
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      REQUIRE_MEMORY_DATA: 'TRUE',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  expect(uppercaseMemoryGate.exitCode).toBe(1)
  expect(new TextDecoder().decode(uppercaseMemoryGate.stderr)).toContain('memory_events has no rows')

  const uppercaseRunGate = Bun.spawnSync(['/bin/bash', validator], {
    env: {
      ...process.env,
      FAKE_KUBECTL_LOG: log,
      FAKE_SUCCEEDED_RUN: '0',
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      REQUIRE_SUCCEEDED_RUN: 'YES',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  expect(uppercaseRunGate.exitCode).toBe(1)
  expect(new TextDecoder().decode(uppercaseRunGate.stderr)).toContain(
    'no succeeded orchestration run with populated stepStatuses found',
  )
})

test('rejects an unsafe API URL before contacting Kubernetes', () => {
  const result = Bun.spawnSync(['/bin/bash', validator], {
    env: {
      ...process.env,
      AGENTS_BASE_URL: 'ftp://agents.example.invalid',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })

  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain('AGENTS_BASE_URL must start with http:// or https://')
})
