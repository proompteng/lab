import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseAllDocuments } from 'yaml'

type Resource = {
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
  spec?: {
    source?: { persistentVolumeClaimName: string }
    dataSource?: { name: string }
    template?: { spec: { containers: { name: string; command: string[] }[] } }
  }
}

const temporaryDirectories: string[] = []
const root = resolve(import.meta.dir, '../../../../..')
const resources = async (namespace: string, filename: string): Promise<Resource[]> =>
  parseAllDocuments(await readFile(join(root, 'argocd/applications', namespace, filename), 'utf8')).map((doc) =>
    doc.toJSON(),
  )
const wave = (resource: Resource) => Number(resource.metadata.annotations?.['argocd.argoproj.io/sync-wave'] ?? '0')
const requireResource = (items: Resource[], kind: string, suffix: string): Resource => {
  const result = items.find((item) => item.kind === kind && item.metadata.name.endsWith(suffix))
  if (!result) throw new Error(`Missing ${kind} ${suffix}`)
  return result
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

for (const [namespace, filename, claim] of [
  ['buzz', 'redis.yaml', 'buzz-redis-buzz-redis-0'],
  ['jangar', 'openwebui-redis.yaml', 'jangar-openwebui-redis-jangar-openwebui-redis-0'],
]) {
  test(`${namespace} keeps the serving Redis behind a snapshot restore rehearsal`, async () => {
    const items = await resources(namespace, 'redis-upgrade-backup.yaml')
    const save = requireResource(items, 'Job', '-v2-save')
    const snapshot = requireResource(items, 'VolumeSnapshot', '-v2-snapshot')
    const clone = requireResource(items, 'PersistentVolumeClaim', '-v2-rehearsal')
    const rehearsal = requireResource(items, 'Job', '-v2-rehearsal')
    const [redis] = await resources(namespace, filename)
    expect([wave(save), wave(snapshot), wave(clone), wave(rehearsal), wave(redis)]).toEqual([-3, -2, -1, 0, 1])
    expect(snapshot.spec?.source?.persistentVolumeClaimName).toBe(claim)
    expect(clone.spec?.dataSource?.name).toBe(snapshot.metadata.name)
    expect(clone.metadata.name).not.toBe(claim)
    for (const retained of [snapshot, clone]) {
      expect(retained.metadata.annotations?.['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
    }
  })

  for (const scenario of ['delayed-ready', 'unreachable', 'save-error', 'persistence-error']) {
    test(`${namespace} backup handles ${scenario} without approving a failed SAVE`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'redis-save-test-'))
      temporaryDirectories.push(directory)
      const items = await resources(namespace, 'redis-upgrade-backup.yaml')
      const job = requireResource(items, 'Job', '-v2-save')
      const command = job.spec?.template?.spec.containers[0].command
      if (!command) throw new Error('Missing save command')
      await writeFile(
        join(directory, 'redis-cli'),
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *PING)
    count=0
    if [ -f "$ATTEMPTS" ]; then count=$(cat "$ATTEMPTS"); fi
    count=$((count + 1))
    echo "$count" > "$ATTEMPTS"
    [ "$SCENARIO" != unreachable ] || exit 1
    [ "$count" -gt 2 ] || exit 1
    echo PONG ;;
  *SAVE)
    [ "$SCENARIO" != save-error ] || { echo 'ERR disk full'; exit 1; }
    echo OK ;;
  *'INFO persistence')
    if [ "$SCENARIO" = persistence-error ]; then echo rdb_last_bgsave_status:err
    else echo rdb_last_bgsave_status:ok; fi ;;
  *) exit 93 ;;
esac
`,
      )
      await writeFile(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n')
      await Promise.all(['redis-cli', 'sleep'].map((name) => chmod(join(directory, name), 0o755)))
      const process = Bun.spawn(command, {
        env: {
          ...Bun.env,
          PATH: `${directory}:${Bun.env.PATH}`,
          SCENARIO: scenario,
          REDIS_HOST: 'test-redis',
          ATTEMPTS: join(directory, 'attempts'),
          CALL_LOG: join(directory, 'calls'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [status, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
      const calls = await readFile(join(directory, 'calls'), 'utf8')
      expect(status === 0).toBe(scenario === 'delayed-ready')
      expect(output.includes('SAVE completed')).toBe(scenario === 'delayed-ready')
      if (scenario === 'unreachable') expect(calls).not.toContain('SAVE')
      else expect(calls.split('\n').filter((line) => line.endsWith(' SAVE'))).toHaveLength(1)
    })
  }
}
