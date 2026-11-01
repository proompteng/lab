import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

test('Ceph read incidents retain host identity, detection delay, OSD detail and recovery hold', () => {
  const root = new URL('../../../../../', import.meta.url)
  const manifest = YAML.parseDocument(
    readFileSync(new URL('argocd/applications/observability/graf-mimir-rules.yaml', root), 'utf8'),
  )
  const contents = manifest.getIn(['data', 'graf-rules.yaml'])
  if (typeof contents !== 'string') throw new Error('Mimir rules are missing')
  const groups = YAML.parseDocument(contents).get('groups')
  if (!YAML.isSeq(groups)) throw new Error('Mimir rule groups are missing')
  const storage = groups.items.find(
    (group) => YAML.isMap(group) && group.get('name') === 'torghut-storage-alerts.rules',
  )
  if (!YAML.isMap(storage)) throw new Error('Storage alert group is missing')
  const directory = mkdtempSync(join(tmpdir(), 'ceph-read-latency-promql-'))
  try {
    writeFileSync(join(directory, 'rules.yaml'), YAML.stringify({ groups: [storage.toJSON()] }))
    writeFileSync(
      join(directory, 'tests.yaml'),
      readFileSync(new URL('argocd/applications/observability/tests/ceph-read-latency-alerts.yaml', root), 'utf8'),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0)
      throw new Error(`Native Ceph rule evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
