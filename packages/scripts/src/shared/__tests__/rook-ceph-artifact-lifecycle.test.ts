import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

import { runnerTelemetryKey } from '../../../../../services/agents/src/runner-telemetry'
import { repoRoot } from '../cli'

const readManifest = (path: string) => YAML.parse(readFileSync(join(repoRoot, 'argocd/applications', path), 'utf8'))
const claim = readManifest('agents/agents-artifacts-objectbucketclaim.yaml')

it('keeps the existing artifact claim, bucket and credentials through GitOps changes', () => {
  expect(claim.metadata).toMatchObject({
    name: 'agents-artifacts',
    namespace: 'agents',
    annotations: { 'argocd.argoproj.io/sync-options': 'Prune=false,Delete=false' },
  })
  expect(claim.spec).toMatchObject({ bucketName: 'agents-artifacts', storageClassName: 'rook-ceph-bucket' })

  const { cephObjectStores } = readManifest('rook-ceph/cluster-values.yaml')
  expect(cephObjectStores).toContainEqual(
    expect.objectContaining({
      name: 'objectstore',
      storageClass: expect.objectContaining({ name: claim.spec.storageClassName, reclaimPolicy: 'Retain' }),
    }),
  )
})

it('adds lifecycle reconciliation without allowing bucket owner or policy changes', () => {
  const operator = readManifest('rook-ceph/operator-values.yaml')
  expect(operator.obcAllowAdditionalConfigFields).toBe('maxObjects,maxSize,bucketLifecycle')
})

it('expires only runner telemetry and aborts abandoned multipart uploads', () => {
  const { bucketLifecycle } = claim.spec.additionalConfig ?? {}
  expect(bucketLifecycle).toBeString()
  const policy = JSON.parse(bucketLifecycle)
  expect(policy).toEqual({
    Rules: [
      {
        ID: 'abort-incomplete-multipart-uploads',
        Status: 'Enabled',
        Prefix: '',
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      },
      {
        ID: 'expire-runner-telemetry',
        Status: 'Enabled',
        Filter: { Prefix: 'runner-telemetry/' },
        Expiration: { Days: 14 },
        NoncurrentVersionExpiration: { NoncurrentDays: 14 },
      },
    ],
  })
  expect(runnerTelemetryKey('agents', 'run-uid')).toStartWith(policy.Rules[1].Filter.Prefix)
})
