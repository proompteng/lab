import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

test('ignores the intentionally suspended Hyperliquid parity gate in Argo health', () => {
  const path = join(repoRoot, 'argocd/applications/torghut-hyperliquid-feed/parity-cronjob.yaml')
  const manifest = YAML.parse(readFileSync(path, 'utf8')) as {
    metadata?: { annotations?: Record<string, string> }
    spec?: { suspend?: boolean }
  }

  expect(manifest.spec?.suspend).toBe(true)
  expect(manifest.metadata?.annotations?.['argocd.argoproj.io/ignore-healthcheck']).toBe('true')
})
