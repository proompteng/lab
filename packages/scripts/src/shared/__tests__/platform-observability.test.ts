import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import YAML, { isMap, isSeq } from 'yaml'

const root = resolve(import.meta.dir, '../../../../..')

test.each([
  ['platform-alerts.yaml', ['ofz-relay-platform.rules', 'tengri-production.rules']],
  ['restate-alerts.yaml', ['restate-control-plane.rules']],
  ['torghut-registry-alerts.yaml', ['torghut-ws.rules', 'registry.rules']],
] as const)('%s fires, clears, and detects missing observations', (fixture, groupNames) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'platform-promql-'))
  try {
    const document = YAML.parseDocument(
      readFileSync(resolve(root, 'argocd/applications/observability/graf-mimir-rules.yaml'), 'utf8'),
    )
    const rules: unknown = document.getIn(['data', 'graf-rules.yaml'])
    if (typeof rules !== 'string') throw new Error('Mimir rules are missing')
    writeFileSync(resolve(directory, 'all-rules.yaml'), rules)
    const groups = YAML.parseDocument(rules).get('groups')
    if (!isSeq(groups)) throw new Error('Mimir rule groups are missing')
    const selected = groupNames.map((name) => {
      const group = groups.items.find((group) => isMap(group) && group.get('name') === name)
      if (!isMap(group)) throw new Error(`Rule group is missing: ${name}`)
      return group.toJSON()
    })
    writeFileSync(resolve(directory, 'rules.yaml'), YAML.stringify({ groups: selected }))
    writeFileSync(
      resolve(directory, 'tests.yaml'),
      readFileSync(resolve(root, `argocd/applications/observability/tests/${fixture}`), 'utf8'),
    )
    for (const args of [
      ['check', 'rules', 'all-rules.yaml'],
      ['test', 'rules', 'tests.yaml'],
    ]) {
      const result = Bun.spawnSync([process.env.PROMTOOL ?? 'promtool', ...args], { cwd: directory })
      expect({ exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }).toEqual({
        exitCode: 0,
        output: expect.stringContaining('SUCCESS'),
      })
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
