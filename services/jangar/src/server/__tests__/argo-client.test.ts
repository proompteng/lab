import { describe, expect, it } from 'vitest'

import { buildArtifactDownloadUrl, extractWorkflowArtifacts } from '~/server/argo-client'

describe('extractWorkflowArtifacts', () => {
  it('captures artifacts from outputs and nodes', () => {
    const workflow = {
      metadata: {
        name: 'github-codex-implementation-abc123',
        namespace: 'argo-workflows',
        uid: 'uid-123',
      },
      status: {
        outputs: {
          artifacts: [
            {
              name: 'implementation-changes',
              s3: { key: 'path/implementation-changes.tgz', bucket: 'argo-workflows' },
            },
          ],
        },
        nodes: {
          'node-1': {
            id: 'node-1',
            outputs: {
              artifacts: [
                {
                  name: 'implementation-changes',
                  s3: { key: 'path/implementation-changes.tgz', bucket: 'argo-workflows' },
                },
                {
                  name: 'implementation-log',
                  s3: { key: 'path/implementation-log.tgz', bucket: 'argo-workflows' },
                },
              ],
            },
          },
          'node-2': {
            id: 'node-2',
            outputs: {
              artifacts: [
                {
                  name: 'implementation-events',
                  http: { url: 'https://example.com/events.jsonl' },
                },
              ],
            },
          },
        },
      },
    }

    const { workflow: info, artifacts } = extractWorkflowArtifacts(workflow)

    expect(info.name).toBe('github-codex-implementation-abc123')
    expect(info.namespace).toBe('argo-workflows')

    const changesWithNode = artifacts.find(
      (artifact) => artifact.name === 'implementation-changes' && artifact.nodeId === 'node-1',
    )
    expect(changesWithNode?.key).toBe('path/implementation-changes.tgz')
    expect(changesWithNode?.bucket).toBe('argo-workflows')

    const eventArtifact = artifacts.find((artifact) => artifact.name === 'implementation-events')
    expect(eventArtifact?.url).toBe('https://example.com/events.jsonl')
  })
})

describe('buildArtifactDownloadUrl', () => {
  it('uses uid-based artifact downloads when available', () => {
    const url = buildArtifactDownloadUrl(
      'http://argo-workflows-server:2746/',
      { name: 'workflow', namespace: 'argo-workflows', uid: 'uid-999' },
      { name: 'implementation-log', nodeId: 'node-1' },
    )
    expect(url).toBe('http://argo-workflows-server:2746/artifacts-by-uid/uid-999/node-1/implementation-log')
  })

  it('falls back to namespace/name when uid is missing', () => {
    const url = buildArtifactDownloadUrl(
      'http://argo-workflows-server:2746',
      { name: 'workflow', namespace: 'argo-workflows', uid: null },
      { name: 'implementation-log', nodeId: 'node-1' },
    )
    expect(url).toBe('http://argo-workflows-server:2746/artifacts/argo-workflows/workflow/node-1/implementation-log')
  })
})
