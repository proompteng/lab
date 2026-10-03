import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import YAML from 'yaml'

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const manifests = (path: string) => YAML.parseAllDocuments(read(path)).map((document) => document.toJSON())
const storagePath = 'argocd/applications/rook-ceph/'
const captureArn = 'arn:aws:s3:::bayn-research/captures/v1/*'
const grantHeaders = ['read', 'write', 'read-acp', 'write-acp', 'full-control']

test('one account-scoped identity can only read and privately write the capture prefix', () => {
  const resources = manifests(`${storagePath}bayn-research-storage.yaml`)
  const account = resources.find((resource) => resource.kind === 'CephObjectStoreAccount')
  expect(account.spec).toEqual({ store: 'objectstore', rootUser: { displayName: 'bayn-research-owner' } })
  expect(account.metadata.annotations['argocd.argoproj.io/sync-options']).toBe('Prune=false,Delete=false')
  const user = resources.find((resource) => resource.kind === 'CephObjectStoreUser')
  expect(user.spec).toEqual({
    store: 'objectstore',
    displayName: 'bayn-research-capture',
    accountRef: { name: 'bayn-research' },
    opMask: ['read', 'write'],
    quotas: { maxBuckets: -1 },
  })
  const policy = JSON.parse(read(`${storagePath}bayn-research-storage-policy.json`))
  expect(policy.Version).toBe('2012-10-17')
  expect(policy.Statement).toHaveLength(10)
  expect(policy.Statement.filter((statement: { Effect: string }) => statement.Effect === 'Allow')).toEqual([
    { Sid: 'ReadCaptureObjects', Effect: 'Allow', Action: 's3:GetObject', Resource: captureArn },
    {
      Sid: 'WritePrivateCaptureObjects',
      Effect: 'Allow',
      Action: 's3:PutObject',
      Resource: captureArn,
      Condition: {
        StringEquals: { 's3:x-amz-acl': 'private' },
        Null: Object.fromEntries(grantHeaders.map((header) => [`s3:x-amz-grant-${header}`, 'true'])),
      },
    },
  ])
  expect(policy.Statement).toContainEqual({
    Sid: 'DenyAllOtherActions',
    Effect: 'Deny',
    NotAction: ['s3:PutObject', 's3:GetObject'],
    Resource: '*',
  })
  expect(policy.Statement).toContainEqual({
    Sid: 'DenyOutsideCapturePrefix',
    Effect: 'Deny',
    Action: ['s3:PutObject', 's3:GetObject'],
    NotResource: captureArn,
  })
  expect(policy.Statement).toContainEqual({
    Sid: 'DenyNonPrivateUploads',
    Effect: 'Deny',
    Action: 's3:PutObject',
    Resource: '*',
    Condition: { StringNotEqualsIfExists: { 's3:x-amz-acl': 'private' } },
  })
  for (const header of grantHeaders) {
    expect(policy.Statement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Effect: 'Deny',
          Action: 's3:PutObject',
          Resource: '*',
          Condition: { Null: { [`s3:x-amz-grant-${header}`]: 'false' } },
        }),
      ]),
    )
  }
})

test('bootstrap waits for both credential pairs and only the application Secret is reflected', () => {
  const resources = manifests(`${storagePath}bayn-research-storage.yaml`)
  const job = resources.find((resource) => resource.kind === 'Job')
  expect(job.spec.template.spec.automountServiceAccountToken).toBe(false)
  expect(job.spec.template.spec.securityContext.runAsNonRoot).toBe(true)
  expect(job.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(true)
  const items = [
    { key: 'AccessKey', path: 'AccessKey' },
    { key: 'SecretKey', path: 'SecretKey' },
  ]
  expect(job.spec.template.spec.volumes.filter((volume: { secret?: unknown }) => volume.secret)).toEqual([
    { name: 'owner', secret: { secretName: 'rook-ceph-object-root-user-bayn-research', items } },
    { name: 'capture', secret: { secretName: 'rook-ceph-object-user-objectstore-bayn-research-capture', items } },
  ])
  const source = resources.filter((resource) => resource.kind === 'Secret')
  expect(source).toHaveLength(1)
  expect(source[0].metadata.name).toBe('rook-ceph-object-user-objectstore-bayn-research-capture')
  expect(source[0].metadata.annotations['reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces']).toBe('bayn')
  const bootstrap = YAML.parse(read('argocd/applicationsets/bootstrap.yaml'))
  const applications = bootstrap.spec.generators[0].matrix.generators[1].list.elements
  const rook = applications.find((application: { name: string }) => application.name === 'rook-ceph')
  expect(rook.ignoreDifferences).toContainEqual({
    kind: 'Secret',
    name: source[0].metadata.name,
    namespace: 'rook-ceph',
    jsonPointers: [
      '/data',
      '/metadata/labels',
      '/metadata/ownerReferences',
      '/metadata/annotations/argocd.argoproj.io~1tracking-id',
    ],
  })
})

test('the capture egress allowance selects only execution workers and the objectstore RGW pod port', () => {
  const resources = manifests('argocd/applications/bayn/research-storage.yaml')
  const policy = resources.find((resource) => resource.kind === 'NetworkPolicy')
  expect(policy.spec).toEqual({
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'bayn-execution-controller' } },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'rook-ceph' } },
            podSelector: {
              matchLabels: { app: 'rook-ceph-rgw', rook_cluster: 'rook-ceph', rook_object_store: 'objectstore' },
            },
          },
        ],
        ports: [{ port: 8080, protocol: 'TCP' }],
      },
    ],
  })
  const secret = resources.find((resource) => resource.kind === 'Secret')
  expect(secret.metadata.annotations['reflector.v1.k8s.emberstack.com/reflects']).toBe(
    'rook-ceph/rook-ceph-object-user-objectstore-bayn-research-capture',
  )
  expect(secret.data).toBeUndefined()
  expect(secret.stringData).toBeUndefined()
})

describe('storage permission proof', () => {
  const run = (mode: string) => {
    const directory = mkdtempSync(join(tmpdir(), 'bayn-storage-proof-'))
    try {
      for (const name of ['owner', 'capture', 'config', 'bin']) mkdirSync(join(directory, name))
      for (const [path, value] of Object.entries({
        'owner/AccessKey': 'synthetic-owner',
        'owner/SecretKey': 'synthetic-owner-secret',
        'capture/AccessKey': 'synthetic-capture',
        'capture/SecretKey': 'synthetic-capture-secret',
        'config/policy.json': read(`${storagePath}bayn-research-storage-policy.json`),
      }))
        writeFileSync(join(directory, path), value)
      writeFileSync(
        join(directory, 'bin/aws'),
        `#!/usr/bin/env bash
set -euo pipefail
shift 6
service=$1
operation=$2
shift 2
if [[ "$AWS_ACCESS_KEY_ID" == synthetic-owner ]]; then
  case "$service/$operation" in
    s3api/create-bucket)
      if [[ "$PROBE_MODE" == existing ]]; then
        echo 'An error occurred (BucketAlreadyOwnedByYou)' >&2; exit 254
      fi
      exit 0 ;;
    s3api/put-bucket-acl|s3api/put-public-access-block|s3api/put-object|iam/put-user-policy) exit 0 ;;
    s3api/get-public-access-block)
      if [[ "$PROBE_MODE" == public ]]; then printf 'False\\tTrue\\tTrue\\tTrue\\n';
      else printf 'True\\tTrue\\tTrue\\tTrue\\n'; fi
      exit 0 ;;
    s3api/get-bucket-acl) echo RGW00000000000000001; exit 0 ;;
    iam/get-user-policy)
      if [[ "$PROBE_MODE" == policy ]]; then echo '{}'; else cat "$PROBE_ROOT/config/policy.json"; fi
      exit 0 ;;
    s3api/get-object) printf 'bayn-research-storage-permission-probe-v1\\n' >"\${!#}"; exit 0 ;;
    *) exit 90 ;;
  esac
fi
[[ "$AWS_ACCESS_KEY_ID" == synthetic-capture ]] || exit 91
if [[ "$service/$operation" == s3api/put-object && "$*" == *'--acl private'* && "$*" == *'--key captures/v1/'* ]]; then exit 0; fi
if [[ "$service/$operation" == s3api/get-object && "$*" != *--no-sign-request* && "$*" == *'--key captures/v1/'* ]]; then
  if [[ "$PROBE_MODE" == corrupt ]]; then printf 'corrupt' >"\${!#}";
  else printf 'bayn-research-storage-permission-probe-v1\\n' >"\${!#}"; fi
  exit 0
fi
if [[ "$PROBE_MODE" == allowed ]]; then exit 0; fi
if [[ "$PROBE_MODE" == network ]]; then echo 'Connection refused' >&2; exit 255; fi
if [[ "$PROBE_MODE" == auth ]]; then echo 'An error occurred (InvalidAccessKeyId)' >&2; exit 254; fi
if [[ "$PROBE_MODE" == missing ]]; then echo 'An error occurred (NoSuchKey)' >&2; exit 254; fi
echo 'An error occurred (AccessDenied) when calling operation' >&2
exit 254
`,
        { mode: 0o700 },
      )
      return Bun.spawnSync({
        cmd: [
          'bash',
          new URL(`${storagePath}bayn-research-storage-bootstrap.sh`, root).pathname,
          join(directory, 'owner'),
          join(directory, 'capture'),
          join(directory, 'config'),
        ],
        env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, PROBE_ROOT: directory, PROBE_MODE: mode },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  for (const mode of ['denied', 'existing']) {
    test(`accepts exact round trips and AccessDenied evidence for ${mode} bootstrap`, () => {
      const result = run(mode)
      expect(result.exitCode).toBe(0)
      const output = result.stdout.toString()
      expect(output).toContain('Verified: only private capture Put/Get')
      expect(output).toContain('Denied: s3api list-buckets (AccessDenied)')
      expect(output).toContain('Denied: s3api create-multipart-upload (AccessDenied)')
      expect(output).not.toContain('synthetic-owner')
      expect(output).not.toContain('synthetic-capture')
    })
  }
  for (const mode of ['allowed', 'network', 'auth', 'missing', 'corrupt', 'policy', 'public']) {
    test(`rejects ${mode} evidence`, () => {
      expect(run(mode).exitCode).not.toBe(0)
    })
  }
})
