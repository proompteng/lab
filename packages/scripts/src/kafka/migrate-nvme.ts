#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StorageBinding } from './verify-nvme-migration'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }
type Role = 'broker' | 'controller'
export type Command = 'plan' | 'copy' | 'rebind' | 'start'

export type Options = {
  command: Command
  context: string
  namespace: string
  cluster: string
  expectedClusterId: string
  pod: string
  targetPv: string
  receiptDir: string
  operatorNamespace: string
  operatorDeployment: string
  timeoutSeconds: number
  yes: boolean
}

export type MigrationPlan = {
  version: 1
  context: string
  namespace: string
  cluster: string
  expectedClusterId: string
  pod: string
  sourcePvc: string
  sourcePv: string
  targetPv: string
  targetStorageClass: string
  targetNode: string
  nodeId: number
  targetPath: string
  role: Role
  resources: { kafka: Obj; pod: Obj; sourcePvc: Obj; sourcePv: Obj; targetPv: Obj; podSet: Obj; desiredPod: Obj }
}

export type Receipt = {
  version: 1
  phase: 'planned' | 'copied' | 'rebound' | 'started'
  updatedAt: string
  plan: MigrationPlan
  tempPvc?: { name: string; uid: string }
  copyPod?: { name: string; uid: string; logs: string }
  finalPvcUid?: string
}

const object = (value: Json | undefined): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const string = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined)
const arr = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : [])
const meta = (resource: Obj) => object(resource.metadata)
const spec = (resource: Obj) => object(resource.spec)
const nameOf = (resource: Obj) => string(meta(resource).name)
const uidOf = (resource: Obj) => string(meta(resource).uid)
const labels = (resource: Obj) => object(meta(resource).labels)
const list = (resource: Obj) =>
  arr(resource.items).filter((item): item is Obj => item !== null && typeof item === 'object' && !Array.isArray(item))

const parseArgs = (argv: string[]) => {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const [key, inline] = token.slice(2).split('=', 2)
    const value = inline ?? (argv[i + 1] === undefined || argv[i + 1]?.startsWith('--') ? 'true' : argv[++i])
    if (value !== undefined) values.set(key, value)
  }
  return values
}

const required = (args: Map<string, string>, key: string) => {
  const value = args.get(key)
  if (!value) throw new Error('missing --' + key)
  return value
}

export const parseOptions = (argv: string[]): Options => {
  const args = parseArgs(argv)
  const commandValue = args.get('command') ?? 'plan'
  if (!['plan', 'copy', 'rebind', 'start'].includes(commandValue)) throw new Error('invalid --command ' + commandValue)
  const command = commandValue as Command
  const number = (key: string, fallback: number) => {
    const value = Number(args.get(key) ?? fallback)
    if (!Number.isInteger(value) || value < 0) throw new Error('invalid --' + key)
    return value
  }
  const namespace = required(args, 'namespace')
  const context = required(args, 'context')
  const expectedClusterId = required(args, 'expected-cluster-id')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(expectedClusterId)) throw new Error('invalid --expected-cluster-id')
  return {
    command,
    context,
    namespace,
    cluster: required(args, 'cluster'),
    expectedClusterId,
    pod: required(args, 'pod'),
    targetPv: required(args, 'target-pv'),
    receiptDir: required(args, 'receipt-dir'),
    operatorNamespace: args.get('operator-namespace') ?? namespace,
    operatorDeployment: args.get('operator-deployment') ?? 'strimzi-cluster-operator',
    timeoutSeconds: number('timeout-seconds', 600),
    yes: args.get('yes') === 'true',
  }
}

type Runner = (args: string[], input?: string) => Promise<{ stdout: string; stderr: string }>

const kubectlRunner = async (args: string[], input?: string) => {
  const child = Bun.spawn(['kubectl', ...args], {
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input !== undefined && child.stdin) {
    await child.stdin.write(input)
    await child.stdin.end()
  }
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  if (code !== 0) throw new Error('kubectl ' + args.join(' ') + ' failed (' + code + ')\n' + stderr.trim())
  return { stdout, stderr }
}

const kube = (options: Options, args: string[], namespaced = true) => [
  '--context',
  options.context,
  ...(namespaced ? ['-n', options.namespace] : []),
  ...args,
]

const json = async (run: Runner, args: string[]) => {
  const parsed: Json = JSON.parse((await run([...args, '-o', 'json'])).stdout)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('kubectl returned non-object JSON')
  return parsed as Obj
}
const get = (run: Runner, options: Options, resource: string, name?: string, namespaced = true) =>
  json(run, kube(options, ['get', resource, ...(name ? [name] : [])], namespaced))
const apply = (run: Runner, options: Options, resource: Obj) =>
  run(kube(options, ['apply', '-f', '-']), JSON.stringify(resource) + '\n')
const patch = (run: Runner, options: Options, resource: string, name: string, value: Obj, namespaced = true) =>
  run(kube(options, ['patch', resource, name, '--type', 'merge', '-p', JSON.stringify(value)], namespaced))
const wait = (run: Runner, options: Options, args: string[]) => run(kube(options, ['wait', ...args]))

export const copyPodFailure = (pod: Obj) => {
  const status = object(pod.status)
  if (status.phase !== 'Failed') return undefined
  const containers = arr(status.containerStatuses).flatMap((item) => {
    const container = object(item)
    const terminated = object(object(container.state).terminated)
    if (Object.keys(terminated).length === 0) return []
    const name = string(container.name) ?? 'container'
    const reason = string(terminated.reason) ?? 'terminated'
    const code = typeof terminated.exitCode === 'number' ? ' exitCode=' + terminated.exitCode : ''
    const message = string(terminated.message)
    return [name + ': ' + reason + code + (message ? ' ' + message : '')]
  })
  const reason = string(status.reason)
  const message = string(status.message)
  return [reason ?? 'phase=Failed', message, ...containers].filter(Boolean).join('; ')
}

export const waitForCopyPod = async (run: Runner, options: Options, name: string) => {
  const deadline = Date.now() + options.timeoutSeconds * 1000
  for (;;) {
    const pod = await get(run, options, 'pod', name)
    const failure = copyPodFailure(pod)
    if (failure) throw new Error('copy pod ' + name + ' failed: ' + failure)
    if (object(pod.status).phase === 'Succeeded') return
    if (Date.now() >= deadline) throw new Error('copy pod ' + name + ' timed out')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

const planPath = (options: Options) => join(options.receiptDir, options.pod + '.plan.json')
const receiptPath = (options: Options) => join(options.receiptDir, options.pod + '.receipt.json')
const save = async (path: string, value: Json) => {
  await mkdir(optionsDir(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
const optionsDir = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '.'
const load = async <T extends Json>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T
const assertUid = (resource: Obj, expected: string | undefined, label: string) => {
  if (!expected || uidOf(resource) !== expected) throw new Error(label + ' UID changed')
}

const claimFromPod = (pod: Obj) => {
  const claims = arr(spec(pod).volumes).flatMap((volume) => {
    const claim = object(object(volume).persistentVolumeClaim)
    const name = string(claim.claimName)
    return name ? [name] : []
  })
  const dataClaims = claims.filter((claim) => claim.startsWith('data-'))
  const selected = dataClaims.length === 1 ? dataClaims[0] : claims.length === 1 ? claims[0] : undefined
  if (!selected) throw new Error('pod must expose exactly one data PVC')
  return selected
}

const pinnedNode = (pv: Obj) => {
  const terms = arr(object(object(spec(pv).nodeAffinity).required).nodeSelectorTerms)
  const nodes = terms.flatMap((term) =>
    arr(object(term).matchExpressions).flatMap((entry) => {
      const value = object(entry)
      return value.key === 'kubernetes.io/hostname' && value.operator === 'In'
        ? arr(value.values).filter((item): item is string => typeof item === 'string')
        : []
    }),
  )
  if (nodes.length !== 1) throw new Error('target PV must pin exactly one hostname')
  return nodes[0]
}

const roleOf = (pod: Obj): Role => {
  const podLabels = labels(pod)
  if (podLabels['strimzi.io/broker-role'] === 'true' || podLabels['kafka.proompteng.ai/role'] === 'broker')
    return 'broker'
  if (podLabels['strimzi.io/controller-role'] === 'true' || podLabels['kafka.proompteng.ai/role'] === 'controller')
    return 'controller'
  throw new Error('pod has no broker/controller role')
}

const nodeIdOf = (pod: Obj) => {
  const value = string(labels(pod)['strimzi.io/broker-id']) ?? string(labels(pod)['strimzi.io/controller-id'])
  const id = Number(value ?? /-(\d+)$/.exec(nameOf(pod) ?? '')?.[1])
  if (!Number.isInteger(id) || id < 0) throw new Error('pod has no numeric Kafka node ID')
  return id
}

const quantity = (value: string | undefined) => {
  const match = value?.match(/^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|Pi|K|M|G|T)?$/)
  if (!match) return undefined
  const factor: Record<string, number> = {
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    Pi: 2 ** 50,
    K: 10 ** 3,
    M: 10 ** 6,
    G: 10 ** 9,
    T: 10 ** 12,
  }
  return Number(match[1]) * (factor[match[2] ?? ''] ?? 1)
}

const desired = (podSets: Obj[], podName: string) => {
  for (const podSet of podSets) {
    const candidate = arr(spec(podSet).pods).find((item) => nameOf(object(item)) === podName)
    if (candidate !== undefined && typeof candidate === 'object' && !Array.isArray(candidate))
      return { podSet, pod: candidate as Obj }
  }
  throw new Error('SPS desired pod not found')
}

const resourcesForPlan = async (run: Runner, options: Options) => {
  const kafka = await get(run, options, 'kafka', options.cluster)
  const pod = await get(run, options, 'pod', options.pod)
  const sourcePvcName = claimFromPod(pod)
  const sourcePvc = await get(run, options, 'pvc', sourcePvcName)
  const sourcePvName = string(spec(sourcePvc).volumeName)
  if (!sourcePvName) throw new Error('source PVC has no bound PV')
  const sourcePv = await get(run, options, 'pv', sourcePvName, false)
  const targetPv = await get(run, options, 'pv', options.targetPv, false)
  const podSets = list(await get(run, options, 'strimzipodset'))
  const selected = desired(podSets, options.pod)
  return {
    kafka,
    pod,
    sourcePvc,
    sourcePv,
    targetPv,
    podSet: selected.podSet,
    desiredPod: selected.pod,
    sourcePvcName,
    sourcePvName,
  }
}

export const buildPlan = (options: Options, resources: Awaited<ReturnType<typeof resourcesForPlan>>): MigrationPlan => {
  const clusterId = string(object(resources.kafka.status).clusterId)
  if (clusterId !== options.expectedClusterId) throw new Error('cluster ID mismatch')
  if (labels(resources.pod)['strimzi.io/cluster'] !== options.cluster)
    throw new Error('pod is not owned by requested cluster')
  const targetSpec = spec(resources.targetPv)
  const targetStorageClass = string(targetSpec.storageClassName)
  const sourceStorageClass = string(spec(resources.sourcePvc).storageClassName)
  if (!targetStorageClass || targetStorageClass === sourceStorageClass)
    throw new Error('target PV must use a different storage class')
  if (!object(targetSpec).local) throw new Error('target PV must be a local PV')
  if (targetSpec.persistentVolumeReclaimPolicy !== 'Retain') throw new Error('target PV must use Retain')
  if (Object.keys(object(targetSpec.claimRef)).length > 0) throw new Error('target PV is already claimed')
  const sourceClaim = object(spec(resources.sourcePv).claimRef)
  if (sourceClaim.uid !== uidOf(resources.sourcePvc) || sourceClaim.name !== resources.sourcePvcName)
    throw new Error('source PV binding mismatch')
  if (resources.sourcePvName === options.targetPv) throw new Error('source and target PV are identical')
  const targetRole = string(labels(resources.targetPv)['kafka.proompteng.ai/role'])
  const role = roleOf(resources.pod)
  if (targetRole && targetRole !== role) throw new Error('target PV role mismatch')
  const targetPath = string(object(targetSpec.local).path)
  if (!targetPath) throw new Error('target PV has no local path')
  const targetNode = pinnedNode(resources.targetPv)
  if (string(spec(resources.pod).nodeName) !== targetNode)
    throw new Error('target PV node must match current Kafka pod node')
  const sourceCapacity = quantity(
    string(object(spec(resources.sourcePv).capacity).storage) ??
      string(
        object(spec(resources.sourcePvc).resources).requests &&
          object(object(spec(resources.sourcePvc).resources).requests).storage,
      ),
  )
  const targetCapacity = quantity(string(object(targetSpec.capacity).storage))
  if (sourceCapacity === undefined || targetCapacity === undefined || targetCapacity < sourceCapacity)
    throw new Error('target PV capacity is smaller than source')
  return {
    version: 1,
    context: options.context,
    namespace: options.namespace,
    cluster: options.cluster,
    expectedClusterId: options.expectedClusterId,
    pod: options.pod,
    sourcePvc: resources.sourcePvcName,
    sourcePv: resources.sourcePvName,
    targetPv: options.targetPv,
    targetStorageClass,
    targetNode,
    nodeId: nodeIdOf(resources.pod),
    targetPath,
    role,
    resources: {
      kafka: resources.kafka,
      pod: resources.pod,
      sourcePvc: resources.sourcePvc,
      sourcePv: resources.sourcePv,
      targetPv: resources.targetPv,
      podSet: resources.podSet,
      desiredPod: resources.desiredPod,
    },
  }
}

export const storageBinding = (
  plan: MigrationPlan,
): Pick<StorageBinding, 'pod' | 'node' | 'role' | 'pvc' | 'pv' | 'storageClass' | 'source' | 'path'> => ({
  pod: plan.pod,
  node: plan.targetNode,
  role: plan.role,
  pvc: plan.sourcePvc,
  pv: plan.targetPv,
  storageClass: plan.targetStorageClass,
  source: 'local',
  path: plan.targetPath,
})

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export const copyScript = (clusterId: string, nodeId: number) =>
  [
    'set -eu',
    'test -z "$(find /target -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)"',
    "cat >/tmp/kafka-migration-check.py <<'PY'",
    'import hashlib, json, os, stat, sys',
    'def validate_lost_found(root):',
    '  path=os.path.join(root,"lost+found")',
    '  if not os.path.lexists(path): return',
    '  info=os.lstat(path)',
    '  if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode): raise SystemExit(root + "/lost+found is not a real directory")',
    '  if os.listdir(path): raise SystemExit(root + "/lost+found must be empty")',
    'def manifest(root):',
    '  validate_lost_found(root)',
    '  rows=[]',
    '  for base, dirs, files in os.walk(root, topdown=True, followlinks=False):',
    '    if base == root: dirs[:] = [name for name in dirs if name != "lost+found"]',
    '    dirs.sort(); files.sort()',
    '    for name in dirs + files:',
    '      path=os.path.join(base,name); rel=os.path.relpath(path,root); st=os.lstat(path)',
    "      kind='d' if stat.S_ISDIR(st.st_mode) else 'l' if stat.S_ISLNK(st.st_mode) else 'f'",
    "      content=os.readlink(path) if kind == 'l' else ''",
    "      if kind == 'f':",
    '        digest=hashlib.sha256()',
    "        with open(path,'rb') as stream:",
    "          for chunk in iter(lambda: stream.read(1048576), b''): digest.update(chunk)",
    '        content=digest.hexdigest()',
    '      attrs=[]',
    '      if hasattr(os,"listxattr"): attrs=[[key,os.getxattr(path,key,follow_symlinks=False).hex()] for key in sorted(os.listxattr(path,follow_symlinks=False))]',
    "      rows.append([rel,kind,st.st_mode,st.st_uid,st.st_gid,st.st_size if kind != 'd' else 0,st.st_mtime_ns,content,attrs])",
    "  return json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode()",
    'def metadata(root):',
    '  result={}',
    '  for base, _, files in os.walk(root):',
    '    for name in files:',
    "      if name == 'meta.properties':",
    "        with open(os.path.join(base,name),encoding='utf-8') as stream:",
    "          result[os.path.relpath(os.path.join(base,name),root)]={line.split('=',1)[0]:line.split('=',1)[1] for line in stream.read().splitlines() if '=' in line}",
    '  return result',
    'root, expected_cluster, expected_node, output = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]',
    'data=manifest(root); rows=json.loads(data); meta=metadata(root)',
    'regular_files=sorted([{"relativePath":row[0],"sizeBytes":str(row[5]),"sha256":row[7]} for row in rows if row[1] == "f"], key=lambda item: item["relativePath"])',
    'assert meta and all(item.get("cluster.id") == expected_cluster and int(item.get("node.id","-1")) == expected_node and item.get("directory.id") for item in meta.values())',
    'result={"digest":hashlib.sha256(data).hexdigest(),"count":len(rows),"totalBytes":sum(int(item["sizeBytes"]) for item in regular_files),"meta":meta,"files":regular_files,"entries":rows}',
    'with open(output,"w",encoding="utf-8") as stream: json.dump(result,stream,separators=(",",":"))',
    'PY',
    'python3 /tmp/kafka-migration-check.py /source ' +
      shellQuote(clusterId) +
      ' ' +
      String(nodeId) +
      ' /tmp/source-manifest.json',
    'cp -a --sparse=always /source/. /target/',
    'sync',
    'python3 /tmp/kafka-migration-check.py /target ' +
      shellQuote(clusterId) +
      ' ' +
      String(nodeId) +
      ' /tmp/target-manifest.json',
    "python3 - <<'PY'",
    'import json',
    'source=json.load(open("/tmp/source-manifest.json",encoding="utf-8"))',
    'target=json.load(open("/tmp/target-manifest.json",encoding="utf-8"))',
    'print("SOURCE_MANIFEST_SHA256=" + source["digest"],flush=True)',
    'print("TARGET_MANIFEST_SHA256=" + target["digest"],flush=True)',
    'print("MANIFEST_ENTRIES=" + str(target["count"]),flush=True)',
    'print("SOURCE_TOTAL_BYTES=" + str(source["totalBytes"]),flush=True)',
    'print("TARGET_TOTAL_BYTES=" + str(target["totalBytes"]),flush=True)',
    'print("SOURCE_META_PROPERTIES=" + json.dumps(source["meta"],separators=(",",":")),flush=True)',
    'print("TARGET_META_PROPERTIES=" + json.dumps(target["meta"],separators=(",",":")),flush=True)',
    'print("SOURCE_FILE_MANIFEST=" + json.dumps(source["files"],separators=(",",":")),flush=True)',
    'print("TARGET_FILE_MANIFEST=" + json.dumps(target["files"],separators=(",",":")),flush=True)',
    'source_files={item["relativePath"]:item for item in source["files"]}',
    'target_files={item["relativePath"]:item for item in target["files"]}',
    'differences=[]',
    'source_entries={row[0]:row for row in source["entries"]}',
    'target_entries={row[0]:row for row in target["entries"]}',
    'for path in sorted(set(source_entries) | set(target_entries)):',
    '  left, right = source_entries.get(path), target_entries.get(path)',
    '  if left != right: differences.append({"path":path,"sourceMetadata":left,"targetMetadata":right})',
    'for path in sorted(set(source_files) | set(target_files)):',
    '  left, right = source_files.get(path), target_files.get(path)',
    '  if left != right: differences.append({"path":path,"source":left,"target":right})',
    'if source["meta"] != target["meta"]: differences.append({"path":"meta.properties","source":source["meta"],"target":target["meta"]})',
    'for field in ["digest","count","totalBytes"]:',
    '  if source[field] != target[field]: differences.append({"path":field,"source":source[field],"target":target[field]})',
    'print("MANIFEST_DIFFERENCES=" + json.dumps(differences,separators=(",",":")),flush=True)',
    'if differences: raise SystemExit("source and target manifests differ")',
    'PY',
    'echo COPY_VERIFIED',
  ].join('\n')

const cleanPod = (plan: MigrationPlan): Obj => {
  const desiredPod = structuredClone(plan.resources.desiredPod)
  const desiredMetadata = object(desiredPod.metadata)
  const metadata: Obj = { name: plan.pod, namespace: plan.namespace }
  for (const key of ['labels', 'annotations', 'ownerReferences'])
    if (desiredMetadata[key] !== undefined) metadata[key] = desiredMetadata[key]
  const podSpec = object(desiredPod.spec)
  delete podSpec.nodeName
  return { apiVersion: 'v1', kind: 'Pod', metadata, spec: podSpec }
}

export const sanitizedOriginalPvc = (plan: MigrationPlan): Obj => {
  const source = structuredClone(plan.resources.sourcePvc)
  const metadata = object(source.metadata)
  for (const key of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'finalizers'])
    delete metadata[key]
  const annotations = object(metadata.annotations)
  for (const key of Object.keys(annotations))
    if (
      key.startsWith('pv.kubernetes.io/') ||
      key.startsWith('volume.kubernetes.io/') ||
      key.startsWith('volume.beta.kubernetes.io/')
    )
      delete annotations[key]
  const pvcSpec = object(source.spec)
  pvcSpec.storageClassName = plan.targetStorageClass
  pvcSpec.volumeName = plan.targetPv
  delete pvcSpec.selector
  delete pvcSpec.dataSource
  delete pvcSpec.dataSourceRef
  delete source.status
  return source
}

const temporaryPvc = (plan: MigrationPlan): Obj => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name: (plan.sourcePvc + '-nvme-copy').slice(0, 63), namespace: plan.namespace },
  spec: {
    accessModes: spec(plan.resources.sourcePvc).accessModes,
    resources: spec(plan.resources.sourcePvc).resources,
    volumeMode: spec(plan.resources.sourcePvc).volumeMode,
    storageClassName: plan.targetStorageClass,
    volumeName: plan.targetPv,
  },
})

const copierPod = (plan: MigrationPlan, image: string): Obj => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: plan.pod + '-nvme-copy', namespace: plan.namespace },
  spec: {
    nodeName: plan.targetNode,
    restartPolicy: 'Never',
    tolerations: spec(plan.resources.desiredPod).tolerations,
    containers: [
      {
        name: 'copy',
        image,
        command: ['/bin/sh', '-ec', copyScript(plan.expectedClusterId, plan.nodeId)],
        securityContext: { runAsUser: 0 },
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '2', memory: '1Gi' } },
        volumeMounts: [
          { name: 'source', mountPath: '/source', readOnly: true },
          { name: 'target', mountPath: '/target' },
        ],
      },
    ],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: plan.sourcePvc, readOnly: true } },
      { name: 'target', persistentVolumeClaim: { claimName: (plan.sourcePvc + '-nvme-copy').slice(0, 63) } },
    ],
  },
})

const identity = (plan: MigrationPlan, options: Options) => {
  const expected: Record<string, string> = {
    context: options.context,
    namespace: options.namespace,
    cluster: options.cluster,
    expectedClusterId: options.expectedClusterId,
    pod: options.pod,
    targetPv: options.targetPv,
  }
  for (const [key, value] of Object.entries(expected))
    if (plan[key as keyof MigrationPlan] !== value) throw new Error('receipt ' + key + ' mismatch')
}

const loadReceipt = async (options: Options) => {
  const receipt = await load<Receipt>(receiptPath(options))
  identity(receipt.plan, options)
  return receipt
}

const operatorStopped = async (run: Runner, options: Options) => {
  const operatorOptions = { ...options, namespace: options.operatorNamespace }
  const deployment = await get(run, operatorOptions, 'deployment', options.operatorDeployment)
  if (spec(deployment).replicas !== 0) throw new Error('operator deployment must already be scaled to zero')
  const selector = object(object(spec(deployment).selector).matchLabels)
  const selectorArg = Object.entries(selector)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => key + '=' + value)
    .join(',')
  const pods = await json(run, kube(operatorOptions, ['get', 'pods', ...(selectorArg ? ['-l', selectorArg] : [])]))
  if (list(pods).length > 0) throw new Error('operator still has live pods')
}

const verifyIdentity = async (run: Runner, options: Options, plan: MigrationPlan, requireSourcePvc = true) => {
  const kafka = await get(run, options, 'kafka', options.cluster)
  assertUid(kafka, uidOf(plan.resources.kafka), 'Kafka')
  if (string(object(kafka.status).clusterId) !== options.expectedClusterId) throw new Error('Kafka cluster ID changed')
  const sourcePvc = await get(run, options, 'pvc', plan.sourcePvc)
  const sourcePv = await get(run, options, 'pv', plan.sourcePv, false)
  const targetPv = await get(run, options, 'pv', plan.targetPv, false)
  const podSet = await get(run, options, 'strimzipodset', nameOf(plan.resources.podSet))
  if (requireSourcePvc) assertUid(sourcePvc, uidOf(plan.resources.sourcePvc), 'source PVC')
  assertUid(sourcePv, uidOf(plan.resources.sourcePv), 'source PV')
  assertUid(targetPv, uidOf(plan.resources.targetPv), 'target PV')
  assertUid(podSet, uidOf(plan.resources.podSet), 'StrimziPodSet')
  return { sourcePvc, sourcePv, targetPv, podSet }
}

const runCopy = async (run: Runner, options: Options) => {
  await operatorStopped(run, options)
  const receipt = await loadReceipt(options)
  if (receipt.phase !== 'planned') return receipt
  const current = await verifyIdentity(run, options, receipt.plan)
  const sourcePod = await get(run, options, 'pod', receipt.plan.pod)
  assertUid(sourcePod, uidOf(receipt.plan.resources.pod), 'source Pod')
  if (string(spec(current.sourcePv).persistentVolumeReclaimPolicy) !== 'Retain')
    await patch(run, options, 'pv', receipt.plan.sourcePv, { spec: { persistentVolumeReclaimPolicy: 'Retain' } }, false)
  const retained = await get(run, options, 'pv', receipt.plan.sourcePv, false)
  if (string(spec(retained).persistentVolumeReclaimPolicy) !== 'Retain')
    throw new Error('source PV Retain guard failed')
  await run(kube(options, ['delete', 'pod', receipt.plan.pod, '--wait=true', '--grace-period=-1']))
  const targetBeforeTemp = await get(run, options, 'pv', receipt.plan.targetPv, false)
  assertUid(targetBeforeTemp, uidOf(receipt.plan.resources.targetPv), 'target PV')
  if (Object.keys(object(spec(targetBeforeTemp).claimRef)).length > 0)
    throw new Error('target PV claimed before temporary PVC')
  const sourceBeforeTemp = await get(run, options, 'pvc', receipt.plan.sourcePvc)
  assertUid(sourceBeforeTemp, uidOf(receipt.plan.resources.sourcePvc), 'source PVC')
  const temp = temporaryPvc(receipt.plan)
  await apply(run, options, temp)
  const image = string(object(arr(spec(receipt.plan.resources.desiredPod).containers)[0]).image)
  if (!image) throw new Error('Kafka image missing from SPS desired pod')
  const copier = copierPod(receipt.plan, image)
  await apply(run, options, copier)
  await wait(run, options, [
    '--for=jsonpath={.status.phase}=Bound',
    'pvc/' + nameOf(temp),
    '--timeout=' + options.timeoutSeconds + 's',
  ])
  const bound = await get(run, options, 'pvc', nameOf(temp)!)
  if (string(spec(bound).volumeName) !== receipt.plan.targetPv) throw new Error('temporary PVC bound to unexpected PV')
  const targetAfterTemp = await get(run, options, 'pv', receipt.plan.targetPv, false)
  assertUid(targetAfterTemp, uidOf(receipt.plan.resources.targetPv), 'target PV')
  if (string(object(spec(targetAfterTemp).claimRef).uid) !== uidOf(bound))
    throw new Error('temporary target binding UID mismatch')
  await waitForCopyPod(run, options, nameOf(copier)!)
  const logs = (await run(kube(options, ['logs', nameOf(copier)!]))).stdout
  if (!logs.includes('COPY_VERIFIED')) throw new Error('copy job did not emit COPY_VERIFIED')
  const copyPodUid = uidOf(await get(run, options, 'pod', nameOf(copier)!))
  await run(kube(options, ['delete', 'pod', nameOf(copier)!, '--wait=true']))
  const next: Receipt = {
    ...receipt,
    phase: 'copied',
    updatedAt: new Date().toISOString(),
    tempPvc: { name: nameOf(temp)!, uid: uidOf(bound)! },
    copyPod: { name: nameOf(copier)!, uid: copyPodUid ?? '', logs },
  }
  await save(receiptPath(options), next as unknown as Json)
  return next
}

const runRebind = async (run: Runner, options: Options) => {
  await operatorStopped(run, options)
  const receipt = await loadReceipt(options)
  if (receipt.phase === 'rebound' || receipt.phase === 'started') return receipt
  if (receipt.phase !== 'copied' || !receipt.tempPvc) throw new Error('copy receipt is required before rebind')
  const plan = receipt.plan
  const identities = await verifyIdentity(run, options, plan)
  const temp = await get(run, options, 'pvc', receipt.tempPvc.name)
  assertUid(temp, receipt.tempPvc.uid, 'temporary PVC')
  if (string(spec(temp).volumeName) !== plan.targetPv) throw new Error('temporary PVC target changed')
  const tempTarget = await get(run, options, 'pv', plan.targetPv, false)
  const tempClaim = object(spec(tempTarget).claimRef)
  if (
    tempClaim.uid !== receipt.tempPvc.uid ||
    tempClaim.name !== receipt.tempPvc.name ||
    tempClaim.namespace !== plan.namespace
  )
    throw new Error('target PV binding UID changed')
  if (string(spec(identities.sourcePv).persistentVolumeReclaimPolicy) !== 'Retain')
    throw new Error('source PV lost Retain guard')
  assertUid(identities.sourcePvc, uidOf(plan.resources.sourcePvc), 'source PVC')
  await run(kube(options, ['delete', 'pvc', plan.sourcePvc, '--wait=true']))
  const releasedSource = await get(run, options, 'pv', plan.sourcePv, false)
  if (string(spec(releasedSource).persistentVolumeReclaimPolicy) !== 'Retain')
    throw new Error('source PV Retain guard changed')
  const targetBeforeCreate = await get(run, options, 'pv', plan.targetPv, false)
  assertUid(targetBeforeCreate, uidOf(plan.resources.targetPv), 'target PV')
  if (string(object(spec(targetBeforeCreate).claimRef).uid) !== receipt.tempPvc.uid)
    throw new Error('target PV claim changed before original PVC creation')
  await apply(run, options, sanitizedOriginalPvc(plan))
  const finalPvc = await get(run, options, 'pvc', plan.sourcePvc)
  const finalUid = uidOf(finalPvc)
  if (!finalUid || string(spec(finalPvc).volumeName) !== plan.targetPv)
    throw new Error('original PVC was not created with target volumeName')
  const targetBeforeReplace = await get(run, options, 'pv', plan.targetPv, false)
  const targetClaim = object(spec(targetBeforeReplace).claimRef)
  if (targetClaim.uid !== receipt.tempPvc.uid) throw new Error('target PV claim changed before atomic handoff')
  const replacement = JSON.stringify([
    { op: 'test', path: '/spec/claimRef/uid', value: receipt.tempPvc.uid },
    {
      op: 'replace',
      path: '/spec/claimRef',
      value: {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        name: plan.sourcePvc,
        namespace: plan.namespace,
        uid: finalUid,
      },
    },
  ])
  await run(kube(options, ['patch', 'pv', plan.targetPv, '--type=json', '-p', replacement], false))
  await wait(run, options, [
    '--for=jsonpath={.status.phase}=Bound',
    'pvc/' + plan.sourcePvc,
    '--timeout=' + options.timeoutSeconds + 's',
  ])
  const finalBound = await get(run, options, 'pvc', plan.sourcePvc)
  if (uidOf(finalBound) !== finalUid || string(spec(finalBound).volumeName) !== plan.targetPv)
    throw new Error('original PVC did not bind target PV')
  const targetAfter = await get(run, options, 'pv', plan.targetPv, false)
  const finalClaim = object(spec(targetAfter).claimRef)
  if (finalClaim.uid !== finalUid || finalClaim.name !== plan.sourcePvc || finalClaim.namespace !== plan.namespace)
    throw new Error('target PV final claim mismatch')
  const tempBeforeDelete = await get(run, options, 'pvc', receipt.tempPvc.name)
  assertUid(tempBeforeDelete, receipt.tempPvc.uid, 'temporary PVC')
  await run(kube(options, ['delete', 'pvc', receipt.tempPvc.name, '--wait=true']))
  const next: Receipt = {
    ...receipt,
    phase: 'rebound',
    updatedAt: new Date().toISOString(),
    finalPvcUid: finalUid,
  }
  await save(receiptPath(options), next as unknown as Json)
  return next
}

const runStart = async (run: Runner, options: Options) => {
  await operatorStopped(run, options)
  const receipt = await loadReceipt(options)
  if (receipt.phase === 'started') return receipt
  if (receipt.phase !== 'rebound') throw new Error('rebind receipt is required before start')
  const plan = receipt.plan
  await verifyIdentity(run, options, plan, false)
  const pvc = await get(run, options, 'pvc', plan.sourcePvc)
  if (string(spec(pvc).volumeName) !== plan.targetPv || uidOf(pvc) !== receipt.finalPvcUid)
    throw new Error('rebound PVC identity changed')
  const target = await get(run, options, 'pv', plan.targetPv, false)
  if (string(object(spec(target).claimRef).uid) !== receipt.finalPvcUid)
    throw new Error('target PV final binding changed')
  const podResult = await run(kube(options, ['get', 'pod', plan.pod, '--ignore-not-found=true', '-o', 'json']))
  const pod = podResult.stdout.trim() ? (JSON.parse(podResult.stdout) as Obj) : undefined
  if (pod) throw new Error('Kafka pod already exists; refusing stale-pod replacement')
  await apply(run, options, cleanPod(plan))
  await wait(run, options, ['--for=condition=Ready', 'pod/' + plan.pod, '--timeout=' + options.timeoutSeconds + 's'])
  const next: Receipt = { ...receipt, phase: 'started', updatedAt: new Date().toISOString() }
  await save(receiptPath(options), next as unknown as Json)
  return next
}

export const runWith = async (options: Options, runner: Runner = kubectlRunner) => {
  await mkdir(options.receiptDir, { recursive: true })
  if (options.command === 'plan') {
    const plan = buildPlan(options, await resourcesForPlan(runner, options))
    let existing: Receipt | undefined
    try {
      existing = await load<Receipt>(receiptPath(options))
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }
    if (existing) {
      identity(existing.plan, options)
      if (existing.phase !== 'planned')
        throw new Error('receipt already advanced; refusing to overwrite it with a new plan')
      for (const [label, before, after] of [
        ['Kafka', existing.plan.resources.kafka, plan.resources.kafka],
        ['source PVC', existing.plan.resources.sourcePvc, plan.resources.sourcePvc],
        ['source PV', existing.plan.resources.sourcePv, plan.resources.sourcePv],
        ['target PV', existing.plan.resources.targetPv, plan.resources.targetPv],
        ['SPS', existing.plan.resources.podSet, plan.resources.podSet],
      ] as const)
        assertUid(after, uidOf(before), label)
    }
    await save(planPath(options), plan as unknown as Json)
    await save(receiptPath(options), {
      version: 1,
      phase: 'planned',
      updatedAt: new Date().toISOString(),
      plan,
    } as unknown as Json)
    return plan
  }
  if (!options.yes) throw new Error('--yes is required for mutation commands')
  const result =
    options.command === 'copy'
      ? await runCopy(runner, options)
      : options.command === 'rebind'
        ? await runRebind(runner, options)
        : await runStart(runner, options)
  return result
}

if (import.meta.main) {
  runWith(parseOptions(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
