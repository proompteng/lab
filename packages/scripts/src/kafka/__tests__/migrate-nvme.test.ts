import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPlan,
  copyPodFailure,
  copyScript,
  parseOptions,
  sanitizedOriginalPvc,
  storageBinding,
  waitForCopyPod,
  type Options,
} from '../migrate-nvme'

const options = (overrides: Partial<Options> = {}): Options => ({
  command: 'plan',
  context: 'galactic-tailscale',
  namespace: 'kafka',
  cluster: 'kafka',
  expectedClusterId: 'cluster-a',
  pod: 'kafka-pool-b-3',
  targetPv: 'kafka-nvme-broker-altra',
  receiptDir: '/tmp/kafka-migration',
  operatorNamespace: 'kafka',
  operatorDeployment: 'strimzi-cluster-operator',
  timeoutSeconds: 60,
  yes: false,
  ...overrides,
})

const resources = () => {
  const sourcePvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'data-kafka-pool-b-3', namespace: 'kafka', uid: 'pvc-a' },
    spec: {
      storageClassName: 'rook-ceph-block',
      volumeName: 'ceph-pv-a',
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '200Gi' } },
      volumeMode: 'Filesystem',
    },
  }
  const sourcePv = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'ceph-pv-a', uid: 'pv-a' },
    spec: {
      storageClassName: 'rook-ceph-block',
      capacity: { storage: '200Gi' },
      persistentVolumeReclaimPolicy: 'Delete',
      claimRef: { name: sourcePvc.metadata.name, uid: sourcePvc.metadata.uid },
    },
  }
  const targetPv = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'kafka-nvme-broker-altra', uid: 'pv-target', labels: { 'kafka.proompteng.ai/role': 'broker' } },
    spec: {
      storageClassName: 'kafka-nvme',
      capacity: { storage: '200Gi' },
      persistentVolumeReclaimPolicy: 'Retain',
      local: { path: '/var/mnt/kafka/broker' },
      nodeAffinity: {
        required: {
          nodeSelectorTerms: [
            { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['altra'] }] },
          ],
        },
      },
    },
  }
  return {
    kafka: { metadata: { name: 'kafka', uid: 'kafka-uid' }, status: { clusterId: 'cluster-a' } },
    pod: {
      metadata: {
        name: 'kafka-pool-b-3',
        uid: 'pod-a',
        labels: { 'strimzi.io/cluster': 'kafka', 'strimzi.io/broker-role': 'true' },
      },
      spec: {
        nodeName: 'altra',
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: sourcePvc.metadata.name } }],
      },
    },
    sourcePvc,
    sourcePv,
    targetPv,
    podSet: {
      metadata: { name: 'kafka-pool-b', uid: 'sps-a' },
      spec: { pods: [{ metadata: { name: 'kafka-pool-b-3' }, spec: {} }] },
    },
    desiredPod: {
      metadata: { name: 'kafka-pool-b-3' },
      spec: {
        nodeName: 'old-node',
        nodeSelector: { zone: 'kafka' },
        containers: [{ name: 'kafka', image: 'strimzi/kafka:4.3.1' }],
      },
    },
    sourcePvcName: sourcePvc.metadata.name,
    sourcePvName: sourcePv.metadata.name,
  } as Parameters<typeof buildPlan>[1]
}

describe('Kafka NVMe migration plan contract', () => {
  it('requires explicit identity and defaults to read-only plan', () => {
    const parsed = parseOptions([
      '--context',
      'ctx',
      '--namespace',
      'ns',
      '--cluster',
      'c',
      '--expected-cluster-id',
      'id',
      '--pod',
      'p',
      '--target-pv',
      'pv',
      '--receipt-dir',
      '/tmp/r',
    ])
    expect(parsed.command).toBe('plan')
    expect(parsed.yes).toBe(false)
    expect(
      parseOptions([
        '--command',
        'copy',
        '--context',
        'ctx',
        '--namespace',
        'ns',
        '--cluster',
        'c',
        '--expected-cluster-id',
        'id',
        '--pod',
        'p',
        '--target-pv',
        'pv',
        '--receipt-dir',
        '/tmp/r',
        '--yes',
      ]).yes,
    ).toBe(true)
    expect(() => parseOptions(['--namespace', 'ns'])).toThrow('missing --context')
  })

  it('captures source and target bindings by live PV identity', () => {
    const plan = buildPlan(options(), resources())
    expect(plan.sourcePv).toBe('ceph-pv-a')
    expect(plan.targetNode).toBe('altra')
    expect(plan.targetPath).toBe('/var/mnt/kafka/broker')
    expect(storageBinding(plan)).toMatchObject({
      source: 'local',
      storageClass: 'kafka-nvme',
      pv: 'kafka-nvme-broker-altra',
    })
  })

  it('rewrites only the PVC binding fields and strips server metadata', () => {
    const plan = buildPlan(options(), resources())
    const pvc = sanitizedOriginalPvc(plan)
    expect(pvc.metadata).not.toHaveProperty('uid')
    expect(pvc.spec).toMatchObject({ storageClassName: 'kafka-nvme', volumeName: 'kafka-nvme-broker-altra' })
  })

  it('refuses a claimed target PV or cluster identity mismatch', () => {
    const claimed = resources()
    ;(claimed.targetPv.spec as Record<string, unknown>).claimRef = { uid: 'other' }
    expect(() => buildPlan(options(), claimed)).toThrow('target PV is already claimed')
    expect(() => buildPlan(options({ expectedClusterId: 'wrong' }), resources())).toThrow('cluster ID mismatch')
  })

  it('uses cp sparse copy plus complete digest and meta.properties checks', () => {
    const script = copyScript('cluster-a', 3)
    expect(script).toContain('cp -a --sparse=always /source/. /target/')
    expect(script).toContain('expected_cluster')
    expect(script).toContain('meta.properties')
    expect(script).toContain('COPY_VERIFIED')
  })

  it('fails immediately when the copy pod enters Failed', async () => {
    expect(
      copyPodFailure({
        status: {
          phase: 'Failed',
          reason: 'Error',
          containerStatuses: [
            { name: 'copy', state: { terminated: { reason: 'Error', exitCode: 1, message: 'manifest mismatch' } } },
          ],
        },
      }),
    ).toContain('exitCode=1')
    const failedPod = { status: { phase: 'Failed', reason: 'Error', message: 'manifest mismatch' } }
    let error: unknown
    try {
      await waitForCopyPod(
        async () => ({ stdout: JSON.stringify(failedPod), stderr: '' }),
        options({ timeoutSeconds: 600 }),
        'copy-pod',
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('manifest mismatch')
  })

  it('executes the manifest copy against sparse files, symlinks, metadata, and meta.properties', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kafka-nvme-copy-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    const wrongTarget = join(root, 'wrong-target')
    const mismatchTarget = join(root, 'mismatch-target')
    const nonemptyTarget = join(root, 'nonempty-target')
    await mkdir(join(source, 'topic'), { recursive: true })
    await mkdir(target)
    await mkdir(wrongTarget)
    await mkdir(mismatchTarget)
    await mkdir(nonemptyTarget)
    await mkdir(join(source, 'lost+found'))
    await mkdir(join(target, 'lost+found'))
    await chmod(join(source, 'lost+found'), 0o700)
    await chmod(join(target, 'lost+found'), 0o755)
    await writeFile(join(source, 'meta.properties'), 'cluster.id=cluster-a\nnode.id=3\ndirectory.id=directory-a\n')
    await writeFile(join(source, 'topic', 'records.log'), 'preserve these records\n')
    await symlink('topic/records.log', join(source, 'records.link'))
    await writeFile(join(source, 'sparse.log'), Buffer.from([1]))
    await truncate(join(source, 'sparse.log'), 1024 * 1024)

    const gcp = Bun.which('gcp')
    const run = async (clusterId: string, destination: string, prelude = '') => {
      const copyCommand = prelude
        ? gcp
          ? 'cp -a --sparse=always'
          : 'cp -a'
        : gcp
          ? gcp + ' -a --sparse=always'
          : 'cp -a'
      const script = copyScript(clusterId, 3)
        .replace('cp -a --sparse=always', copyCommand)
        .replaceAll('/tmp/source-manifest.json', '__SOURCE_MANIFEST__')
        .replaceAll('/tmp/target-manifest.json', '__TARGET_MANIFEST__')
        .replaceAll('/source', source)
        .replaceAll('/target', destination)
        .replaceAll('__SOURCE_MANIFEST__', '/tmp/source-manifest.json')
        .replaceAll('__TARGET_MANIFEST__', '/tmp/target-manifest.json')
        .replace('set -eu', prelude ? 'set -eu\n' + prelude : 'set -eu')
      const child = Bun.spawn(['bash', '-euc', script], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code: await child.exited, stdout, stderr }
    }

    const result = await run('cluster-a', target)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('COPY_VERIFIED')
    expect(result.stdout).toContain('MANIFEST_ENTRIES=5\n')
    expect(await readFile(join(target, 'topic', 'records.log'), 'utf8')).toBe('preserve these records\n')
    expect(await readFile(join(target, 'meta.properties'), 'utf8')).toContain('directory.id=directory-a')
    const sparseSource = await stat(join(source, 'sparse.log'))
    const sparseTarget = await stat(join(target, 'sparse.log'))
    expect(sparseTarget.size).toBe(sparseSource.size)
    if (gcp) expect(sparseTarget.blocks).toBeLessThan(sparseTarget.size / 512)
    const realCp = gcp ?? 'cp'
    const mismatch = await run(
      'cluster-a',
      mismatchTarget,
      'cp() { ' + realCp + ' "$@"; printf "corrupted\\n" > ' + mismatchTarget + '/topic/records.log; }',
    )
    expect(mismatch.code, mismatch.stderr).not.toBe(0)
    expect(mismatch.stdout).toContain('SOURCE_FILE_MANIFEST=')
    expect(mismatch.stdout).toContain('TARGET_FILE_MANIFEST=')
    expect(mismatch.stdout).toContain('MANIFEST_DIFFERENCES=')
    expect(mismatch.stdout).toContain('records.log')
    const wrong = await run('wrong-cluster', wrongTarget)
    expect(wrong.code).not.toBe(0)
    await writeFile(join(source, 'lost+found', 'unexpected'), 'do not ignore this')
    const nonempty = await run('cluster-a', nonemptyTarget)
    expect(nonempty.code, nonempty.stderr).not.toBe(0)
    expect(nonempty.stderr).toContain('lost+found must be empty')
  })

  it('starts from the captured SPS pod after the original PVC receives a new UID', async () => {
    const plan = buildPlan(options(), resources())
    const receiptDir = await mkdtemp(join(tmpdir(), 'kafka-nvme-receipt-'))
    const receipt = {
      version: 1 as const,
      phase: 'rebound' as const,
      updatedAt: new Date().toISOString(),
      plan,
      finalPvcUid: 'pvc-final',
    }
    await writeFile(join(receiptDir, plan.pod + '.receipt.json'), JSON.stringify(receipt), { mode: 0o600 })
    const startOptions = options({ command: 'start', receiptDir, yes: true })
    type ResourceShape = { metadata: Record<string, unknown>; spec: Record<string, unknown> }
    const sourcePvcResource = JSON.parse(JSON.stringify(plan.resources.sourcePvc)) as ResourceShape
    const targetPvResource = JSON.parse(JSON.stringify(plan.resources.targetPv)) as ResourceShape
    const calls: string[][] = []
    const runner = async (args: string[], input?: string) => {
      calls.push(args)
      const resource = args[args.indexOf('get') + 1]
      if (args.includes('get') && args.includes('deployment'))
        return {
          stdout: JSON.stringify({ spec: { replicas: 0, selector: { matchLabels: { app: 'operator' } } } }),
          stderr: '',
        }
      if (args.includes('get') && args.includes('pods')) return { stdout: JSON.stringify({ items: [] }), stderr: '' }
      if (resource === 'kafka') return { stdout: JSON.stringify(plan.resources.kafka), stderr: '' }
      if (resource === 'strimzipodset') return { stdout: JSON.stringify(plan.resources.podSet), stderr: '' }
      if (args.includes('get') && args.includes('pvc'))
        return {
          stdout: JSON.stringify({
            ...sourcePvcResource,
            metadata: { ...sourcePvcResource.metadata, uid: 'pvc-final' },
            spec: { ...sourcePvcResource.spec, volumeName: plan.targetPv },
          }),
          stderr: '',
        }
      if (args.includes('get') && args.includes('pv') && args.includes(plan.sourcePv))
        return { stdout: JSON.stringify(plan.resources.sourcePv), stderr: '' }
      if (args.includes('get') && args.includes('pv'))
        return {
          stdout: JSON.stringify({
            ...targetPvResource,
            spec: {
              ...targetPvResource.spec,
              claimRef: { name: plan.sourcePvc, namespace: plan.namespace, uid: 'pvc-final' },
            },
          }),
          stderr: '',
        }
      if (args.includes('get') && args.includes('pod')) {
        if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '' }
        throw new Error('pod not found')
      }
      if (args.includes('apply')) {
        const applied = JSON.parse(input ?? '{}') as { spec?: { nodeName?: string } }
        expect(applied.spec?.nodeName).toBeUndefined()
      }
      return { stdout: '', stderr: '' }
    }
    const result = await (await import('../migrate-nvme')).runWith(startOptions, runner)
    if (!('phase' in result)) throw new Error('start did not return a receipt')
    expect(result.phase).toBe('started')
    expect(calls.some((args) => args.includes('apply'))).toBe(true)
  })
})
