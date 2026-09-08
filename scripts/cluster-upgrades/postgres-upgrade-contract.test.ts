import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const preflight = resolve(import.meta.dir, 'postgres-upgrade-preflight.sh')
const postflight = resolve(import.meta.dir, 'postgres-upgrade-postflight.sh')
const imagePlan = resolve(import.meta.dir, 'postgres-upgrade-image-plan.yaml')
const temporaryDirectories: string[] = []

const preparationImage =
  'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e'
const majorImage =
  'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533'

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

const clusterFixture = (image: string, majorVersion: number, currentPrimary?: string) =>
  JSON.stringify({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { name: 'demo', namespace: 'demo' },
    spec: { instances: 1, bootstrap: { initdb: { database: 'postgres' } } },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      currentPrimary,
      phase: 'Cluster in healthy state',
      pgDataImageInfo: { image, majorVersion },
      readyInstances: 1,
    },
  })

const fakeKubectlSource = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_KUBECTL_LOG"
printf '%s' "$1" >> "$FAKE_KUBECTL_ARGV_LOG"
for argument in "__DOLLAR__{@:2}"; do
  printf '\t%s' "$argument" >> "$FAKE_KUBECTL_ARGV_LOG"
done
printf '\n' >> "$FAKE_KUBECTL_ARGV_LOG"

if [[ "__DOLLAR__{1:-}" != "cnpg" && ( "__DOLLAR__{1:-}" != "--context" || "__DOLLAR__{2:-}" != "$FAKE_EXPECTED_CONTEXT" ) ]]; then
  echo "unexpected kube context: $*" >&2
  exit 90
fi

if [[ "$*" == *"get cluster demo -o json"* ]]; then
  cat "$FAKE_CLUSTER_JSON"
  exit 0
fi

if [[ "$*" == *"get backups.postgresql.cnpg.io"* ]]; then
  cat "$FAKE_BACKUPS_JSON"
  exit 0
fi

if [[ "$*" == *"cnpg psql"* ]]; then
  if [[ -n "__DOLLAR__{FAKE_FAIL_SQL:-}" && "__DOLLAR__{FAKE_FAIL_SQL:-}" == "__DOLLAR__{13:-}" ]]; then
    echo "controlled cnpg query failure: __DOLLAR__{13:-}" >&2
    exit 92
  fi
  if [[ "$*" == *"current_setting('server_version_num')"* ]]; then
    printf '180006\n'
  elif [[ "$*" == *"FROM pg_database"* ]]; then
    printf 'app\n'
  elif [[ "$*" == *"FROM pg_extension"* ]]; then
    if [[ "$*" == *"extname || chr(9) || extversion"* ]]; then
      printf 'plpgsql\t1.0\nvector\t0.8.6\n'
    else
      printf 'plpgsql\nvector\n'
    fi
  elif [[ "$*" == *"pg_size_pretty"* ]]; then
    printf '10 MB\n'
  else
    echo "unexpected cnpg query: $*" >&2
    exit 91
  fi
  exit 0
fi

if [[ "$*" == *" exec "* && "$*" == *" test -s "* ]]; then
  [[ "__DOLLAR__{FAKE_SCRIPT_PRESENT:-0}" == "1" ]]
  exit
fi

if [[ "$*" == *" exec "* && "$*" == *" psql "* ]]; then
  printf '%s\n' "$*" >> "$FAKE_APPLY_LOG"
  [[ "$*" != *"--dbname"* ]] || exit 92
  exit 0
fi

echo "unexpected kubectl call: $*" >&2
exit 93
`.replaceAll('__DOLLAR__', '$')

const createFixture = async (mode: 'preflight' | 'postflight', backups: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'postgres-upgrade-contract-'))
  temporaryDirectories.push(directory)
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  const fakeKubectl = join(bin, 'kubectl')
  const clusterJson = join(directory, 'cluster.json')
  const backupsJson = join(directory, 'backups.json')
  const kubectlLog = join(directory, 'kubectl.log')
  const kubectlArgvLog = join(directory, 'kubectl-argv.log')
  const applyLog = join(directory, 'apply.log')
  await writeFile(fakeKubectl, fakeKubectlSource, 'utf8')
  await chmod(fakeKubectl, 0o755)
  await writeFile(
    clusterJson,
    clusterFixture(mode === 'preflight' ? preparationImage : majorImage, mode === 'preflight' ? 17 : 18, 'demo-1'),
    'utf8',
  )
  await writeFile(backupsJson, backups, 'utf8')
  await writeFile(kubectlLog, '', 'utf8')
  await writeFile(kubectlArgvLog, '', 'utf8')
  await writeFile(applyLog, '', 'utf8')
  return { applyLog, backupsJson, bin, clusterJson, fakeKubectl, kubectlArgvLog, kubectlLog }
}

const runScript = (
  script: string,
  args: string[],
  fixture: Awaited<ReturnType<typeof createFixture>>,
  extraEnvironment: Record<string, string> = {},
) => {
  const inheritedEnvironment = { ...process.env }
  delete inheritedEnvironment.KUBE_CONTEXT
  const result = Bun.spawnSync(['/bin/bash', script, ...args], {
    env: {
      ...inheritedEnvironment,
      FAKE_APPLY_LOG: fixture.applyLog,
      FAKE_BACKUPS_JSON: fixture.backupsJson,
      FAKE_CLUSTER_JSON: fixture.clusterJson,
      FAKE_EXPECTED_CONTEXT: 'galactic-lan',
      FAKE_KUBECTL_ARGV_LOG: fixture.kubectlArgvLog,
      FAKE_KUBECTL_LOG: fixture.kubectlLog,
      JQ_BIN: 'jq',
      KUBECTL_BIN: fixture.fakeKubectl,
      PATH: `${fixture.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      ...extraEnvironment,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
  }
}

test('PostgreSQL upgrade helpers are executable and read-only by default', async () => {
  for (const path of [preflight, postflight]) {
    const source = await readFile(path, 'utf8')
    const mode = await Bun.file(path).stat()
    expect(mode.mode & 0o111).not.toBe(0)
    expect(source).toContain('set -eo pipefail')
    expect(source).toContain('printf galactic-lan')
    expect(source).toContain('--context "$KUBE_CONTEXT"')
    expect(source).not.toMatch(/kubectl[^\n]*(?:apply|patch|create|delete)/i)
  }
})

test('preparation backup resources are fixed, explicit, and non-pruning', async () => {
  const namespaces = ['agents', 'app', 'attic', 'bilig', 'coder', 'forgejo', 'keycloak', 'synthesis']
  const documents = await Promise.all(
    namespaces.map((namespace) =>
      readFile(resolve(root, `argocd/applications/${namespace}/postgres-upgrade-backup.yaml`), 'utf8'),
    ),
  )
  expect(documents).toHaveLength(8)
  for (const document of documents) {
    expect(document).toContain('method: volumeSnapshot')
    expect(document).toContain('online: false')
    expect(document).toContain('target: primary')
    expect(document).toContain('argocd.argoproj.io/sync-wave: "-10"')
    expect(document).toContain('argocd.argoproj.io/sync-options: Prune=false')
  }
})

test('passes the verified kube context to every preflight kubectl call and supports an override', async () => {
  const fixture = await createFixture('preflight', '{"items":[]}')
  const args = ['--namespace', 'demo', '--cluster', 'demo', '--target-image', preparationImage, '--phase', 'prepare']

  const defaultResult = runScript(preflight, args, fixture)
  expect(defaultResult.exitCode).toBe(0)
  const defaultCalls = (await readFile(fixture.kubectlLog, 'utf8')).trim().split('\n')
  expect(defaultCalls.every((call) => call.includes('--context galactic-lan'))).toBe(true)

  await writeFile(fixture.kubectlLog, '', 'utf8')
  const overrideResult = runScript(preflight, [...args, '--context', 'galactic-test'], fixture, {
    FAKE_EXPECTED_CONTEXT: 'galactic-test',
  })
  expect(overrideResult.exitCode).toBe(0)
  const overrideCalls = (await readFile(fixture.kubectlLog, 'utf8')).trim().split('\n')
  expect(overrideCalls.every((call) => call.includes('--context galactic-test'))).toBe(true)
})

test('places CNPG plugin flags after the plugin and fails closed on a query error', async () => {
  const fixture = await createFixture('preflight', '{"items":[]}')
  const args = ['--namespace', 'demo', '--cluster', 'demo', '--target-image', preparationImage, '--phase', 'prepare']
  const databaseQuery = 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;'
  const extensionQuery = 'SELECT extname FROM pg_extension ORDER BY 1;'

  const result = runScript(preflight, args, fixture)
  expect(result.exitCode).toBe(0)

  const calls = (await readFile(fixture.kubectlArgvLog, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((call) => call.split('\t'))
  const cnpgCalls = calls.filter((call) => call[0] === 'cnpg')
  expect(cnpgCalls).toHaveLength(2)
  for (const call of cnpgCalls) {
    expect(call.slice(0, 8)).toEqual(['cnpg', 'psql', 'demo', '--context', 'galactic-lan', '--namespace', 'demo', '--'])
    expect(call.slice(8, 12)).toEqual(['-d', call[9], '-At', '-c'])
  }
  expect(cnpgCalls.map((call) => call[9])).toEqual(['postgres', 'app'])
  expect(cnpgCalls.map((call) => call[12])).toEqual([databaseQuery, extensionQuery])

  await writeFile(fixture.kubectlArgvLog, '', 'utf8')
  const failedResult = runScript(preflight, args, fixture, { FAKE_FAIL_SQL: extensionQuery })
  expect(failedResult.exitCode).toBe(1)
  expect(failedResult.stderr).toContain('unable to inspect extensions in database app')

  const failedCalls = (await readFile(fixture.kubectlArgvLog, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((call) => call.split('\t'))
  const failedCnpgCall = failedCalls.find((call) => call[0] === 'cnpg' && call[12] === extensionQuery)
  expect(failedCnpgCall?.slice(0, 8)).toEqual([
    'cnpg',
    'psql',
    'demo',
    '--context',
    'galactic-lan',
    '--namespace',
    'demo',
    '--',
  ])
})

test('fails closed for missing and stale major-upgrade backups', async () => {
  const scenarios = [
    { backups: '{"items":[]}', message: 'no completed CNPG Backup exists' },
    {
      backups: JSON.stringify({
        items: [
          {
            metadata: { name: 'demo-stale' },
            spec: { cluster: { name: 'demo' }, method: 'volumeSnapshot' },
            status: { phase: 'completed', stoppedAt: '1970-01-01T00:00:00Z' },
          },
        ],
      }),
      message: 'is 3600 s old',
    },
  ]

  for (const scenario of scenarios) {
    const fixture = await createFixture('preflight', scenario.backups)
    const result = runScript(
      preflight,
      ['--namespace', 'demo', '--cluster', 'demo', '--target-image', majorImage, '--phase', 'major'],
      fixture,
      { MAX_BACKUP_AGE_SECONDS: '60', NOW_EPOCH: '3600' },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(scenario.message)
  }
})

test('accepts tabbed extension rows, validates postflight plugin argv, and runs update_extensions.sql once', async () => {
  const fixture = await createFixture('postflight', '{"items":[]}')
  const args = ['--namespace', 'demo', '--cluster', 'demo', '--expected-image', majorImage]
  const expectedQueries = [
    "SELECT current_setting('server_version_num');",
    'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;',
    'SELECT extname || chr(9) || extversion FROM pg_extension ORDER BY 1;',
    'SELECT pg_size_pretty(pg_database_size(current_database()));',
  ]

  const pendingResult = runScript(postflight, args, fixture, { FAKE_SCRIPT_PRESENT: '1' })
  expect(pendingResult.exitCode).toBe(1)
  expect(pendingResult.stdout).toContain('vector\t0.8.6')
  expect(pendingResult.stderr).toContain('rerun with --apply-extension-updates')
  expect(pendingResult.stderr).not.toContain('unsupported extension')

  await writeFile(fixture.kubectlLog, '', 'utf8')
  await writeFile(fixture.kubectlArgvLog, '', 'utf8')
  await writeFile(fixture.applyLog, '', 'utf8')
  const applyResult = runScript(postflight, [...args, '--apply-extension-updates'], fixture, {
    FAKE_SCRIPT_PRESENT: '1',
  })
  expect(applyResult.exitCode).toBe(0)
  expect(applyResult.stdout).toContain('Applied generated extension updates')
  const applyCalls = (await readFile(fixture.applyLog, 'utf8')).trim().split('\n').filter(Boolean)
  expect(applyCalls).toHaveLength(1)
  expect(applyCalls[0]).toContain('--context galactic-lan')
  expect(applyCalls[0]).toContain('exec -i demo-1')
  expect(applyCalls[0]).toContain('--file /var/lib/postgresql/data/pgdata/update_extensions.sql')
  expect(applyCalls[0]).not.toContain('--dbname')

  const argvCalls = (await readFile(fixture.kubectlArgvLog, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((call) => call.split('\t'))
  const cnpgCalls = argvCalls.filter((call) => call[0] === 'cnpg')
  expect(cnpgCalls).toHaveLength(expectedQueries.length)
  for (const call of cnpgCalls) {
    expect(call.slice(0, 8)).toEqual(['cnpg', 'psql', 'demo', '--context', 'galactic-lan', '--namespace', 'demo', '--'])
    expect(call.slice(8, 12)).toEqual(['-d', call[9], '-At', '-c'])
  }
  expect(cnpgCalls.map((call) => call[12])).toEqual(expectedQueries)

  const calls = (await readFile(fixture.kubectlLog, 'utf8')).trim().split('\n').filter(Boolean)
  expect(calls.every((call) => call.includes('--context galactic-lan'))).toBe(true)
})

test('postflight fails closed when a CNPG query fails and preserves plugin context argv', async () => {
  const fixture = await createFixture('postflight', '{"items":[]}')
  const args = ['--namespace', 'demo', '--cluster', 'demo', '--expected-image', majorImage]
  const serverVersionQuery = "SELECT current_setting('server_version_num');"

  const result = runScript(postflight, args, fixture, { FAKE_FAIL_SQL: serverVersionQuery })
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('unable to query PostgreSQL server_version_num')

  const calls = (await readFile(fixture.kubectlArgvLog, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((call) => call.split('\t'))
  const failedCall = calls.find((call) => call[0] === 'cnpg')
  expect(failedCall?.slice(0, 8)).toEqual([
    'cnpg',
    'psql',
    'demo',
    '--context',
    'galactic-lan',
    '--namespace',
    'demo',
    '--',
  ])
  expect(failedCall?.[12]).toBe(serverVersionQuery)
})

test('the twelve owned clusters use only approved images from the rerunnable plan', async () => {
  const entries = [
    {
      path: 'argocd/applications/agents/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: true,
    },
    {
      path: 'argocd/applications/app/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: true,
    },
    {
      path: 'argocd/applications/attic/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: true,
    },
    {
      path: 'argocd/applications/bayn/postgres-cluster.yaml',
      current:
        'ghcr.io/cloudnative-pg/postgresql:18.4-system-trixie@sha256:9287ce030c6f3ce822e383b019ae4aaf1e8370bff3b39f9c51dc10d69dc97219',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: false,
    },
    {
      path: 'argocd/applications/bilig/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: true,
    },
    {
      path: 'argocd/applications/buzz/postgres-cluster.yaml',
      current:
        'ghcr.io/cloudnative-pg/postgresql:17.7-system-trixie@sha256:08775f8bdeb112878b8f2ef63578c47959ee332fc9e076d5d6735a710c4500e2',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11-system-trixie@sha256:362b039f643f1c09a34edd63d9a78903e5f1f4f43c24236cc8459621eb676d12',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: false,
    },
    {
      path: 'argocd/applications/coder/coder-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: true,
    },
    {
      path: 'argocd/applications/forgejo/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: true,
    },
    {
      path: 'argocd/applications/jangar/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: false,
    },
    {
      path: 'argocd/applications/keycloak/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: true,
    },
    {
      path: 'argocd/applications/synthesis/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:18.3-system-trixie',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie@sha256:5a6a677d3fa2bc3fdc61874e0de8324b5a987eb676ddca133e71365a8467d6c1',
      configWave: true,
    },
    {
      path: 'argocd/applications/torghut/postgres-cluster.yaml',
      current: 'ghcr.io/cloudnative-pg/postgresql:17.0',
      preparation:
        'ghcr.io/cloudnative-pg/postgresql:17.11@sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e',
      major:
        'ghcr.io/cloudnative-pg/postgresql:18.6-system-bullseye@sha256:899d3ed526b659d77935dde0e6bf2d69dbbf17d3d8c6486ca8cfd04bd3c18533',
      configWave: false,
    },
  ] as const

  const plan = await readFile(imagePlan, 'utf8')
  expect(entries).toHaveLength(12)
  for (const entry of entries) {
    const source = await readFile(resolve(root, entry.path), 'utf8')
    const image = source.match(/^  imageName: ([^\n]+)$/m)?.[1]
    expect(image).toBeDefined()
    expect([entry.current, entry.preparation, entry.major]).toContain(image)
    expect(plan).toContain(`manifest: ${entry.path}`)
    expect(plan).toContain(`currentImage: ${entry.current}`)
    expect(plan).toContain(`preparationImage: ${entry.preparation}`)
    expect(plan).toContain(`majorImage: ${entry.major}`)
    if (entry.configWave) {
      expect(source).toContain('className: rook-ceph-block')
      const kustomization = await readFile(resolve(root, entry.path.replace(/\/[^/]+$/, '/kustomization.yaml')), 'utf8')
      if (image === entry.current) {
        expect(kustomization).not.toContain('postgres-upgrade-backup.yaml')
      } else {
        expect(kustomization).toContain('postgres-upgrade-backup.yaml')
      }
      const backupPath = entry.path.replace(/\/[^/]+$/, '/postgres-upgrade-backup.yaml')
      expect(plan).toContain(`backupManifest: ${backupPath}`)
      const backup = await readFile(resolve(root, backupPath), 'utf8')
      expect(backup).toContain('kind: Backup')
      expect(backup).toContain('method: volumeSnapshot')
    }
  }
})
