import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'
import YAML from 'yaml'
import { mimirRuleGroup, observabilityDirectory } from './mimir-rules'

const rules = YAML.stringify({ groups: [mimirRuleGroup('torghut-storage-alerts.rules')] })

test.each(['ceph-read-latency-alerts.yaml', 'ceph-health-alerts.yaml', 'persistent-volume-alerts.yaml'])(
  'Storage alerts preserve incident identity and capacity semantics: %s',
  (fixture) => {
    const directory = mkdtempSync(join(tmpdir(), 'ceph-read-latency-promql-'))
    try {
      writeFileSync(join(directory, 'rules.yaml'), rules)
      writeFileSync(
        join(directory, 'tests.yaml'),
        readFileSync(new URL(`tests/${fixture}`, observabilityDirectory), 'utf8'),
      )
      const result = spawnSync(process.env.PROMTOOL ?? 'promtool', ['test', 'rules', 'tests.yaml'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (result.error || result.status !== 0)
        throw new Error(
          `Native storage rule evaluation failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
        )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
