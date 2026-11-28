import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'

test('Ceph metadata and scrub records retain units, daemon identity, idle and reset semantics', () => {
  const root = new URL('../../../../../', import.meta.url)
  const manifest = YAML.parse(
    readFileSync(new URL('argocd/applications/observability/graf-mimir-rules.yaml', root), 'utf8'),
  )
  const groups = YAML.parse(manifest.data['graf-rules.yaml']).groups
  const group = groups.find((entry: { name: string }) => entry.name === 'ceph-performance.rules')
  if (!group) throw new Error('Ceph performance rule group is missing')
  const directory = mkdtempSync(join(tmpdir(), 'ceph-metadata-promql-'))
  try {
    writeFileSync(join(directory, 'rules.yaml'), YAML.stringify({ groups: [group] }))
    writeFileSync(
      join(directory, 'tests.yaml'),
      readFileSync(new URL('argocd/applications/observability/tests/ceph-metadata-records.yaml', root), 'utf8'),
    )
    const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`Native Ceph metric evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
