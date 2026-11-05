import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import YAML, { isMap, isSeq } from 'yaml'

const root = resolve(import.meta.dir, '../../../../..')

test('platform runtime and promotion alerts fire, clear, and detect missing observations', () => {
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
    const platform = groups.items.find((group) => isMap(group) && group.get('name') === 'ofz-relay-platform.rules')
    if (!isMap(platform)) throw new Error('Platform rule group is missing')
    writeFileSync(resolve(directory, 'rules.yaml'), YAML.stringify({ groups: [platform.toJSON()] }))
    writeFileSync(
      resolve(directory, 'tests.yaml'),
      readFileSync(resolve(root, 'argocd/applications/observability/tests/platform-alerts.yaml'), 'utf8'),
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
