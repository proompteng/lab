import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { repoRoot } from '../../shared/cli'
import { __private } from '../update-hyperliquid-feed-manifest'

describe('update-hyperliquid-feed-manifest', () => {
  it('updates the feed image and source metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'torghut-hyperliquid-feed-manifest-test-'))
    const manifestPath = join(dir, 'deployment.yaml')
    writeFileSync(
      manifestPath,
      `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: torghut-hyperliquid-feed
          image: registry.ide-newton.ts.net/lab/torghut-hyperliquid-feed@sha256:1111111111111111111111111111111111111111111111111111111111111111
          env:
            - name: TORGHUT_HYPERLIQUID_FEED_VERSION
              value: old-version
            - name: TORGHUT_HYPERLIQUID_FEED_COMMIT
              value: old-commit
            - name: TORGHUT_HYPERLIQUID_FEED_IMAGE_DIGEST
              value: sha256:1111111111111111111111111111111111111111111111111111111111111111
`,
      'utf8',
    )

    const result = __private.updateHyperliquidFeedManifest(
      'registry.ide-newton.ts.net/lab/torghut-hyperliquid-feed',
      'sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
      'main-30c43f62',
      '30c43f624e57af68cb633b36d136c0fedd29a10e',
      relative(repoRoot, manifestPath),
    )

    const updated = readFileSync(manifestPath, 'utf8')
    expect(updated).toContain(
      'image: registry.ide-newton.ts.net/lab/torghut-hyperliquid-feed@sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e',
    )
    expect(updated).toContain('value: main-30c43f62')
    expect(updated).toContain('value: 30c43f624e57af68cb633b36d136c0fedd29a10e')
    expect(updated).toContain('value: sha256:430763ebeeda8734e1da3ae8c6b665bcc1b380fb815317fffc98371cccea219e')
    expect(result.changed).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it('parses manifest override options', () => {
    const options = __private.parseArgs([
      '--manifest-path',
      'argocd/applications/torghut-hyperliquid-feed/deployment.yaml',
      '--container-name=torghut-hyperliquid-feed',
    ])

    expect(options.manifestPath).toBe('argocd/applications/torghut-hyperliquid-feed/deployment.yaml')
    expect(options.containerName).toBe('torghut-hyperliquid-feed')
  })
})
