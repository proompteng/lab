import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { resolveArtifactUploadConfig, uploadOutputArtifacts } from './artifact-upload'

describe('agent runner artifact upload', () => {
  it('resolves storage config from canonical and reflected secret env names', () => {
    expect(
      resolveArtifactUploadConfig({
        MINIO_ENDPOINT: 'rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80',
        MINIO_BUCKET: 'argo-workflows',
        accesskey: 'minio-access',
        secretkey: 'minio-secret',
        MINIO_SECURE: 'false',
      }),
    ).toMatchObject({
      endpoint: 'http://rook-ceph-rgw-objectstore.rook-ceph.svc.cluster.local:80',
      bucket: 'argo-workflows',
      accessKey: 'minio-access',
      secretKey: 'minio-secret',
      region: 'us-east-1',
      secure: false,
    })
  })

  it('uploads keyed outputArtifacts with S3-compatible SigV4 PUT and returns stable artifact references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-artifacts-'))
    const artifactPath = join(dir, 'codex-artifact.json')
    await writeFile(artifactPath, '{"ok":true}\n', 'utf8')

    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response('', { status: 200 })
    })

    const uploaded = await uploadOutputArtifacts(
      [
        {
          name: 'codex-artifact',
          path: artifactPath,
          key: 'codex-research/run-1/codex-artifact.json',
        },
      ],
      {
        env: {
          AGENTS_ARTIFACTS_ENDPOINT: 'http://storage.internal:9000',
          AGENTS_ARTIFACTS_BUCKET: 'argo-workflows',
          AGENTS_ARTIFACTS_ACCESS_KEY_ID: 'access',
          AGENTS_ARTIFACTS_SECRET_ACCESS_KEY: 'secret',
        },
        fetch: fetchImpl as unknown as typeof fetch,
        now: () => new Date('2026-05-19T12:00:00.000Z'),
      },
    )

    expect(uploaded).toEqual([
      {
        name: 'codex-artifact',
        path: artifactPath,
        key: 'codex-research/run-1/codex-artifact.json',
        url: 's3://argo-workflows/codex-research/run-1/codex-artifact.json',
      },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'http://storage.internal:9000/argo-workflows/codex-research/run-1/codex-artifact.json',
    )
    expect(requests[0]?.init?.method).toBe('PUT')
    expect(requests[0]?.init?.headers).toMatchObject({
      'x-amz-date': '20260519T120000Z',
    })
    expect(String((requests[0]?.init?.headers as Record<string, string>).Authorization)).toContain(
      'AWS4-HMAC-SHA256 Credential=access/20260519/us-east-1/s3/aws4_request',
    )
  })

  it('requires storage config when an outputArtifact declares an upload key', async () => {
    await expect(
      uploadOutputArtifacts([{ name: 'codex-artifact', path: '/tmp/missing.json', key: 'codex/research.json' }], {
        env: {},
      }),
    ).rejects.toThrow('artifact upload is required')
  })

  it('leaves unkeyed outputArtifacts as local descriptors without storage config', async () => {
    await expect(
      uploadOutputArtifacts([{ name: 'runner-log', path: '/workspace/.agent/runner.log' }], { env: {} }),
    ).resolves.toEqual([{ name: 'runner-log', path: '/workspace/.agent/runner.log' }])
  })
})
