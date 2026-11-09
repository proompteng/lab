import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPlan,
  copyPodFailure,
  copyScript,
  parseOptions,
  runWith,
  sanitizedOriginalPvc,
  storageBinding,
  waitForCopyPod,
  type Options,
  type Receipt,
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

  it(
    'executes the manifest copy against sparse files, symlinks, metadata, and meta.properties',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'kafka-nvme-copy-'))
      const source = join(root, 'source')
      const target = join(root, 'target')
      const wrongTarget = join(root, 'wrong-target')
      const mismatchTarget = join(root, 'mismatch-target')
      const nonemptyTarget = join(root, 'nonempty-target')
      const injectionTarget = join(root, 'injection-target')
      await mkdir(join(source, 'topic'), { recursive: true })
      await mkdir(target)
      await mkdir(wrongTarget)
      await mkdir(mismatchTarget)
      await mkdir(nonemptyTarget)
      await mkdir(injectionTarget)
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
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
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
      const realCp = gcp ?? Bun.which('cp')
      if (!realCp) throw new Error('cp executable is required for the copy fixture')
      const quotedCp = "'" + realCp.replaceAll("'", "'\"'\"'") + "'"
      const mismatch = await run(
        'cluster-a',
        mismatchTarget,
        'cp() { ' + quotedCp + ' "$@"; printf "corrupted\\n" > ' + mismatchTarget + '/topic/records.log; }',
      )
      expect(mismatch.code, mismatch.stderr).not.toBe(0)
      expect(mismatch.stdout).toContain('SOURCE_FILE_MANIFEST=')
      expect(mismatch.stdout).toContain('TARGET_FILE_MANIFEST=')
      expect(mismatch.stdout).toContain('MANIFEST_DIFFERENCES=')
      expect(mismatch.stdout).toContain('records.log')
      const wrong = await run('wrong-cluster', wrongTarget)
      expect(wrong.code).not.toBe(0)
      const injected = join(root, 'injected')
      const injection = await run('cluster-a$(touch ' + injected + ')', injectionTarget)
      expect(injection.code).not.toBe(0)
      expect(await Bun.file(injected).exists()).toBe(false)
      await writeFile(join(source, 'lost+found', 'unexpected'), 'do not ignore this')
      const nonempty = await run('cluster-a', nonemptyTarget)
      expect(nonempty.code, nonempty.stderr).not.toBe(0)
      expect(nonempty.stderr).toContain('lost+found must be empty')
    },
    { timeout: 15_000 },
  )

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
    let startedPod: unknown
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
        if (startedPod) return { stdout: JSON.stringify(startedPod), stderr: '' }
        if (args.includes('--ignore-not-found=true')) return { stdout: '', stderr: '' }
        throw new Error('pod not found')
      }
      if (args.includes('apply')) {
        const applied = JSON.parse(input ?? '{}') as { spec?: { nodeName?: string } }
        expect(applied.spec?.nodeName).toBeUndefined()
        startedPod = { ...applied, metadata: { ...(applied as { metadata: object }).metadata, uid: 'started-uid' } }
      }
      return { stdout: '', stderr: '' }
    }
    const result = await (await import('../migrate-nvme')).runWith(startOptions, runner)
    if (!('phase' in result)) throw new Error('start did not return a receipt')
    expect(result.phase).toBe('started')
    expect(calls.some((args) => args.includes('apply'))).toBe(true)
  })

  it('resumes rebind after observed destructive mutations', async () => {
    const failurePoints = [
      'after-source-delete',
      'after-pvc-create',
      'after-pv-swap',
      'after-temp-delete',
      'before-final-receipt',
    ] as const
    type Resource = {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
      status?: Record<string, unknown>
    }
    const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as Resource
    const empty = () => ({ stdout: '', stderr: '' })

    for (const failurePoint of failurePoints) {
      const plan = buildPlan(options(), resources())
      const receiptDir = await mkdtemp(join(tmpdir(), 'kafka-nvme-rebind-'))
      const tempName = plan.sourcePvc + '-nvme-copy'
      const tempUid = 'pvc-temp'
      const source = clone(plan.resources.sourcePvc)
      const sourcePv = clone(plan.resources.sourcePv)
      sourcePv.spec.persistentVolumeReclaimPolicy = 'Retain'
      const target = clone(plan.resources.targetPv)
      target.spec.persistentVolumeReclaimPolicy = 'Retain'
      target.spec.claimRef = { name: tempName, namespace: plan.namespace, uid: tempUid }
      const temp = {
        metadata: { name: tempName, namespace: plan.namespace, uid: tempUid },
        spec: { storageClassName: plan.targetStorageClass, volumeName: plan.targetPv },
      } as Resource
      const state: { source?: Resource; sourcePv: Resource; target: Resource; temp?: Resource; failed: boolean } = {
        source,
        sourcePv,
        target,
        temp,
        failed: false,
      }
      const receipt: Receipt = {
        version: 1,
        phase: 'copied',
        updatedAt: new Date().toISOString(),
        plan,
        tempPvc: { name: tempName, uid: tempUid },
      }
      const receiptPath = join(receiptDir, plan.pod + '.receipt.json')
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })

      const runner = async (args: string[], input?: string) => {
        const command = args[args.indexOf('get') + 1]
        if (args.includes('get')) {
          if (command === 'deployment')
            return {
              stdout: JSON.stringify({ spec: { replicas: 0, selector: { matchLabels: { app: 'operator' } } } }),
              stderr: '',
            }
          if (command === 'pods') return { stdout: JSON.stringify({ items: [] }), stderr: '' }
          if (command === 'kafka') return { stdout: JSON.stringify(plan.resources.kafka), stderr: '' }
          if (command === 'strimzipodset') return { stdout: JSON.stringify(plan.resources.podSet), stderr: '' }
          if (command === 'pv') {
            const name = args[args.indexOf('get') + 2]
            return { stdout: JSON.stringify(name === plan.sourcePv ? state.sourcePv : state.target), stderr: '' }
          }
          if (command === 'pvc') {
            const name = args[args.indexOf('get') + 2]
            const resource = name === plan.sourcePvc ? state.source : name === tempName ? state.temp : undefined
            return resource ? { stdout: JSON.stringify(resource), stderr: '' } : empty()
          }
        }
        if (args.includes('delete') && args.includes('pvc')) {
          const name = args[args.indexOf('delete') + 2]
          if (name === plan.sourcePvc) {
            state.source = undefined
            if (failurePoint === 'after-source-delete' && !state.failed) {
              state.failed = true
              throw new Error('injected after source PVC delete')
            }
          }
          if (name === tempName) {
            state.temp = undefined
            if (failurePoint === 'after-temp-delete' && !state.failed) {
              state.failed = true
              throw new Error('injected after temporary PVC delete')
            }
          }
          return empty()
        }
        if (args.includes('apply')) {
          const applied = JSON.parse(input ?? '{}') as Resource
          state.source = { ...applied, metadata: { ...applied.metadata, uid: 'pvc-final-' + failurePoint } }
          if (failurePoint === 'after-pvc-create' && !state.failed) {
            state.failed = true
            throw new Error('injected after new PVC create')
          }
          return empty()
        }
        if (args.includes('patch') && args.includes(plan.targetPv)) {
          const operations = JSON.parse(args[args.indexOf('-p') + 1]) as Array<{ op: string; value?: unknown }>
          state.target.spec.claimRef = operations.find((operation) => operation.op === 'replace')?.value
          if (failurePoint === 'after-pv-swap' && !state.failed) {
            state.failed = true
            throw new Error('injected after PV claimRef swap')
          }
          return empty()
        }
        if (args.includes('wait')) {
          if (failurePoint === 'before-final-receipt' && !state.failed) {
            state.failed = true
            throw new Error('injected before final receipt save')
          }
          return empty()
        }
        return empty()
      }

      let firstError: unknown
      try {
        await runWith(options({ command: 'rebind', receiptDir, yes: true }), runner)
      } catch (error) {
        firstError = error
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt).rebind?.operationId).toBeTruthy()
      if (failurePoint === 'after-source-delete') expect(state.source).toBeUndefined()
      if (failurePoint === 'after-pvc-create') expect(state.source?.metadata.uid).toBe('pvc-final-after-pvc-create')
      if (failurePoint === 'after-pv-swap' || failurePoint === 'before-final-receipt')
        expect((state.target.spec.claimRef as Record<string, unknown>).uid).toBe('pvc-final-' + failurePoint)

      const resumed = await runWith(options({ command: 'rebind', receiptDir, yes: true }), runner)
      expect(resumed).toMatchObject({ phase: 'rebound', finalPvcUid: 'pvc-final-' + failurePoint })
      expect(state.temp).toBeUndefined()
      const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
      expect(saved.rebind?.stage).toBe('pv-swapped')
    }
  })

  it('refuses a same-name PVC with a foreign UID or missing operation marker', async () => {
    const plan = buildPlan(options(), resources())
    const receiptDir = await mkdtemp(join(tmpdir(), 'kafka-nvme-foreign-'))
    const tempName = plan.sourcePvc + '-nvme-copy'
    const tempUid = 'pvc-temp'
    const source = JSON.parse(JSON.stringify(plan.resources.sourcePvc)) as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    source.metadata.uid = 'foreign-pvc'
    const sourcePv = JSON.parse(JSON.stringify(plan.resources.sourcePv)) as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    sourcePv.spec.persistentVolumeReclaimPolicy = 'Retain'
    const target = JSON.parse(JSON.stringify(plan.resources.targetPv)) as {
      metadata: Record<string, unknown>
      spec: Record<string, unknown>
    }
    target.spec.persistentVolumeReclaimPolicy = 'Retain'
    target.spec.claimRef = { name: tempName, namespace: plan.namespace, uid: tempUid }
    const receipt: Receipt = {
      version: 1,
      phase: 'copied',
      updatedAt: new Date().toISOString(),
      plan,
      tempPvc: { name: tempName, uid: tempUid },
      rebind: {
        stage: 'source-deleted',
        sourcePvcUid: 'pvc-a',
        sourcePvUid: 'pv-a',
        targetPvUid: 'pv-target',
        tempPvcUid: tempUid,
        operationId: 'deadbeef-12345678',
      },
    }
    await writeFile(join(receiptDir, plan.pod + '.receipt.json'), JSON.stringify(receipt), { mode: 0o600 })
    const calls: string[][] = []
    const runner = async (args: string[]) => {
      calls.push(args)
      const command = args[args.indexOf('get') + 1]
      if (command === 'deployment')
        return {
          stdout: JSON.stringify({ spec: { replicas: 0, selector: { matchLabels: { app: 'operator' } } } }),
          stderr: '',
        }
      if (command === 'pods') return { stdout: JSON.stringify({ items: [] }), stderr: '' }
      if (command === 'kafka') return { stdout: JSON.stringify(plan.resources.kafka), stderr: '' }
      if (command === 'strimzipodset') return { stdout: JSON.stringify(plan.resources.podSet), stderr: '' }
      if (command === 'pvc') {
        const name = args[args.indexOf('get') + 2]
        if (name === plan.sourcePvc) return { stdout: JSON.stringify(source), stderr: '' }
        return {
          stdout: JSON.stringify({
            metadata: { name: tempName, namespace: plan.namespace, uid: tempUid },
            spec: { volumeName: plan.targetPv },
          }),
          stderr: '',
        }
      }
      if (command === 'pv') {
        const name = args[args.indexOf('get') + 2]
        return { stdout: JSON.stringify(name === plan.sourcePv ? sourcePv : target), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }
    let rejected: unknown
    try {
      await runWith(options({ command: 'rebind', receiptDir, yes: true }), runner)
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toContain('new PVC operation marker changed')
    expect(calls.some((args) => args.includes('delete') || args.includes('apply') || args.includes('patch'))).toBe(
      false,
    )
  })
  it('resumes copy and startup after lost API acknowledgments without repeating the copy', async () => {
    type Resource = { kind?: string; metadata: Record<string, unknown>; spec: Record<string, unknown>; status?: object }
    for (const failurePoint of [
      'stop',
      'temp-create',
      'copy-create',
      'copy-logs',
      'copy-delete',
      'start-create',
      'start-ready',
    ]) {
      const plan = buildPlan(options(), resources())
      const receiptDir = await mkdtemp(join(tmpdir(), 'kafka-nvme-resume-'))
      const receiptPath = join(receiptDir, plan.pod + '.receipt.json')
      const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as Resource
      const sourcePv = clone(plan.resources.sourcePv)
      sourcePv.spec.persistentVolumeReclaimPolicy = 'Retain'
      const target = clone(plan.resources.targetPv)
      let sourcePod: Resource | undefined = clone(plan.resources.pod)
      let copier: Resource | undefined
      let temp: Resource | undefined
      let finalPvc: Resource | undefined
      let failed = false
      let copyCreates = 0
      const inject = (point: string) => {
        if (failurePoint === point && !failed) {
          failed = true
          throw new Error('lost acknowledgment ' + point)
        }
      }
      const initial: Receipt = { version: 1, phase: 'planned', updatedAt: new Date().toISOString(), plan }
      await writeFile(receiptPath, JSON.stringify(initial))
      const runner = async (args: string[], input?: string) => {
        const empty = { stdout: '', stderr: '' }
        const response = (value: unknown) => (value ? { stdout: JSON.stringify(value), stderr: '' } : empty)
        if (args.includes('get')) {
          const at = args.indexOf('get')
          const resource = args[at + 1]
          const name = args[at + 2]
          if (resource === 'deployment')
            return response({ spec: { replicas: 0, selector: { matchLabels: { app: 'operator' } } } })
          if (resource === 'pods') return response({ items: [] })
          if (resource === 'kafka') return response(plan.resources.kafka)
          if (resource === 'strimzipodset') return response(plan.resources.podSet)
          if (resource === 'pv') return response(name === plan.sourcePv ? sourcePv : target)
          if (resource === 'pvc')
            return response(name === plan.sourcePvc ? (finalPvc ?? plan.resources.sourcePvc) : temp)
          if (resource === 'pod') return response(name === plan.pod ? sourcePod : copier)
        }
        if (args.includes('delete') && args.includes('pod')) {
          if (args.includes(plan.pod)) {
            sourcePod = undefined
            inject('stop')
          } else {
            copier = undefined
            inject('copy-delete')
          }
        }
        if (args.includes('apply')) {
          const resource = JSON.parse(input!) as Resource
          if (resource.kind === 'PersistentVolumeClaim') {
            temp = { ...resource, metadata: { ...resource.metadata, uid: 'temp-uid' } }
            target.spec.claimRef = { name: temp.metadata.name, namespace: plan.namespace, uid: 'temp-uid' }
            inject('temp-create')
          } else if (resource.metadata.name === plan.pod) {
            sourcePod = { ...resource, metadata: { ...resource.metadata, uid: 'started-uid' } }
            inject('start-create')
          } else {
            copyCreates += 1
            copier = {
              ...resource,
              metadata: { ...resource.metadata, uid: 'copy-uid' },
              status: { phase: 'Succeeded' },
            }
            inject('copy-create')
          }
        }
        if (args.includes('logs')) {
          inject('copy-logs')
          return { stdout: 'COPY_VERIFIED', stderr: '' }
        }
        if (args.includes('wait') && args.includes('pod/' + plan.pod)) inject('start-ready')
        return empty
      }
      const copyOptions = options({ command: 'copy', receiptDir, yes: true })
      const expectLostAcknowledgment = async (operation: Promise<unknown>) => {
        let caught: unknown
        try {
          await operation
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(Error)
        expect((caught as Error).message).toContain('lost acknowledgment')
      }
      if (failurePoint.startsWith('start')) await runWith(copyOptions, runner)
      else {
        await expectLostAcknowledgment(runWith(copyOptions, runner))
        expect(((await runWith(copyOptions, runner)) as Receipt).phase).toBe('copied')
      }
      expect(copyCreates).toBe(1)
      expect(copier).toBeUndefined()
      const copied = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
      expect(copied.copyPod?.logs).toBe('COPY_VERIFIED')
      finalPvc = clone(plan.resources.sourcePvc)
      finalPvc.metadata.uid = 'final-uid'
      finalPvc.spec.volumeName = plan.targetPv
      target.spec.claimRef = { name: plan.sourcePvc, namespace: plan.namespace, uid: 'final-uid' }
      await writeFile(receiptPath, JSON.stringify({ ...copied, phase: 'rebound', finalPvcUid: 'final-uid' }))
      const startOptions = options({ command: 'start', receiptDir, yes: true })
      if (failurePoint.startsWith('start')) await expectLostAcknowledgment(runWith(startOptions, runner))
      expect(((await runWith(startOptions, runner)) as Receipt).phase).toBe('started')
    }
  })
})
