#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  rebind?: RebindJournal
  copy?: { operationId: string; tempPvcUid?: string; copyPodUid?: string }
  start?: { operationId: string; finalPvcUid: string; podUid?: string }
}

type RebindStage = 'armed' | 'source-deleted' | 'pvc-created' | 'pv-swapped'
type RebindJournal = {
  stage: RebindStage
  sourcePvcUid: string
  sourcePvUid: string
  targetPvUid: string
  tempPvcUid: string
  operationId: string
  finalPvcUid?: string
}

const migrationMarker = 'kafka.proompteng.ai/nvme-migration'

const marked = (resource: Obj, operationId: string): Obj => {
  const metadata = meta(resource)
  metadata.annotations = { ...object(metadata.annotations), [migrationMarker]: operationId }
  return resource
}

const matchesDesired = (actual: Json | undefined, desired: Json): boolean => {
  if (Array.isArray(desired))
    return Array.isArray(actual) && desired.every((value, index) => matchesDesired(actual[index], value))
  if (desired !== null && typeof desired === 'object')
    return Object.entries(desired).every(([key, value]) => matchesDesired(object(actual)[key], value))
  return actual === desired
}

const assertOwnedResource = (resource: Obj, desired: Obj, operationId: string, expectedUid?: string) => {
  if (string(object(meta(resource).annotations)[migrationMarker]) !== operationId)
    throw new Error('migration resource operation marker changed')
  if (expectedUid) assertUid(resource, expectedUid, 'migration resource')
  if (!matchesDesired(spec(resource), spec(desired))) throw new Error('migration resource specification changed')
}

const object = (value: Json | undefined): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
const string = (value: Json | undefined): string | undefined => (typeof value === 'string' ? value : undefined)
const arr = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : [])
const meta = (resource: Obj) => object(resource.metadata)
const spec = (resource: Obj) => object(resource.spec)
const nameOf = (resource: Obj) => string(meta(resource).name)
const uidOf = (resource: Obj | undefined) => string(resource ? meta(resource).uid : undefined)
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
const getMaybe = async (run: Runner, options: Options, resource: string, name: string, namespaced = true) => {
  const output = await run(kube(options, ['get', resource, name, '--ignore-not-found=true', '-o', 'json'], namespaced))
  if (!output.stdout.trim()) return undefined
  const parsed: Json = JSON.parse(output.stdout)
  if (parsed === null) return undefined
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('kubectl returned non-object JSON')
  return parsed as Obj
}
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
const assertUid = (resource: Obj | undefined, expected: string | undefined, label: string) => {
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

export const sanitizedOriginalPvc = (plan: MigrationPlan, operationId?: string): Obj => {
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
  if (operationId) annotations[migrationMarker] = operationId
  if (operationId) metadata.annotations = annotations
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

const claimIdentity = (claim: Obj) => ({
  uid: string(claim.uid),
  name: string(claim.name),
  namespace: string(claim.namespace),
})

const assertTempBinding = (pv: Obj, plan: MigrationPlan, temp: { name: string; uid: string }) => {
  const claim = claimIdentity(object(spec(pv).claimRef))
  if (claim.uid !== temp.uid || claim.name !== temp.name || claim.namespace !== plan.namespace)
    throw new Error('target PV binding is not the recorded temporary PVC')
}

const assertFinalPvc = (pvc: Obj, plan: MigrationPlan, operationId: string, expectedUid?: string) => {
  const metadata = meta(pvc)
  const annotations = object(metadata.annotations)
  if (expectedUid && uidOf(pvc) !== expectedUid) throw new Error('new PVC UID changed')
  if (nameOf(pvc) !== plan.sourcePvc || string(metadata.namespace) !== plan.namespace)
    throw new Error('new PVC name or namespace changed')
  if (string(annotations[migrationMarker]) !== operationId) throw new Error('new PVC operation marker changed')
  const pvcLabels = labels(pvc)
  for (const key of ['strimzi.io/cluster', 'strimzi.io/pool-name']) {
    const expected = string(labels(plan.resources.sourcePvc)[key])
    if (expected !== undefined && string(pvcLabels[key]) !== expected) throw new Error('new PVC label changed: ' + key)
  }
  if (string(spec(pvc).storageClassName) !== plan.targetStorageClass) throw new Error('new PVC storage class changed')
  if (string(spec(pvc).volumeName) !== plan.targetPv) throw new Error('new PVC volumeName changed')
}

const assertJournal = (receipt: Receipt, journal: RebindJournal) => {
  const expected = {
    sourcePvcUid: uidOf(receipt.plan.resources.sourcePvc),
    sourcePvUid: uidOf(receipt.plan.resources.sourcePv),
    targetPvUid: uidOf(receipt.plan.resources.targetPv),
    tempPvcUid: receipt.tempPvc?.uid,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!value || journal[key as keyof typeof expected] !== value) throw new Error('rebind journal ' + key + ' changed')
  }
  if (!journal.operationId || !/^[0-9a-f-]{16,128}$/i.test(journal.operationId))
    throw new Error('rebind journal operation ID is invalid')
}

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
  const sourcePvc = requireSourcePvc
    ? await get(run, options, 'pvc', plan.sourcePvc)
    : await getMaybe(run, options, 'pvc', plan.sourcePvc)
  const sourcePv = await get(run, options, 'pv', plan.sourcePv, false)
  const targetPv = await get(run, options, 'pv', plan.targetPv, false)
  const podSet = await get(run, options, 'strimzipodset', nameOf(plan.resources.podSet))
  if (requireSourcePvc) assertUid(sourcePvc, uidOf(plan.resources.sourcePvc), 'source PVC')
  assertUid(sourcePv, uidOf(plan.resources.sourcePv), 'source PV')
  assertUid(targetPv, uidOf(plan.resources.targetPv), 'target PV')
  assertUid(podSet, uidOf(plan.resources.podSet), 'StrimziPodSet')
  return { sourcePvc, sourcePv, targetPv, podSet }
}

const cleanupCopyPod = async (run: Runner, options: Options, receipt: Receipt) => {
  if (!receipt.copyPod) return
  const pod = await getMaybe(run, options, 'pod', receipt.copyPod.name)
  if (!pod) return
  assertUid(pod, receipt.copyPod.uid, 'verified copy Pod')
  await run(kube(options, ['delete', 'pod', receipt.copyPod.name, '--wait=true']))
}

const runCopy = async (run: Runner, options: Options) => {
  await operatorStopped(run, options)
  let receipt = await loadReceipt(options)
  if (receipt.phase !== 'planned') {
    await cleanupCopyPod(run, options, receipt)
    return receipt
  }
  const plan = receipt.plan
  const current = await verifyIdentity(run, options, plan)
  let sourcePod = await getMaybe(run, options, 'pod', plan.pod)
  if (!receipt.copy) {
    assertUid(sourcePod, uidOf(plan.resources.pod), 'source Pod')
    receipt = { ...receipt, copy: { operationId: randomUUID() }, updatedAt: new Date().toISOString() }
    await save(receiptPath(options), receipt as unknown as Json)
  }
  const journal = receipt.copy!
  const saveCopy = async () => {
    receipt = { ...receipt, copy: { ...journal }, updatedAt: new Date().toISOString() }
    await save(receiptPath(options), receipt as unknown as Json)
  }
  if (string(spec(current.sourcePv).persistentVolumeReclaimPolicy) !== 'Retain')
    await patch(run, options, 'pv', plan.sourcePv, { spec: { persistentVolumeReclaimPolicy: 'Retain' } }, false)
  const retained = await get(run, options, 'pv', plan.sourcePv, false)
  if (string(spec(retained).persistentVolumeReclaimPolicy) !== 'Retain')
    throw new Error('source PV Retain guard failed')
  if (sourcePod) {
    assertUid(sourcePod, uidOf(plan.resources.pod), 'source Pod')
    if (journal.tempPvcUid || journal.copyPodUid) throw new Error('source Pod exists after copy resources were created')
    await run(kube(options, ['delete', 'pod', plan.pod, '--wait=true', '--grace-period=-1']))
  }
  sourcePod = await getMaybe(run, options, 'pod', plan.pod)
  if (sourcePod) throw new Error('source Pod still exists after stop boundary')
  const temp = marked(temporaryPvc(plan), journal.operationId)
  let bound = await getMaybe(run, options, 'pvc', nameOf(temp)!)
  if (!bound) {
    if (journal.tempPvcUid) throw new Error('recorded temporary PVC is missing')
    const target = await get(run, options, 'pv', plan.targetPv, false)
    assertUid(target, uidOf(plan.resources.targetPv), 'target PV')
    if (Object.keys(object(spec(target).claimRef)).length > 0) throw new Error('target PV claimed before temporary PVC')
    await apply(run, options, temp)
    bound = await get(run, options, 'pvc', nameOf(temp)!)
  }
  assertOwnedResource(bound, temp, journal.operationId, journal.tempPvcUid)
  journal.tempPvcUid = uidOf(bound)
  if (!journal.tempPvcUid) throw new Error('temporary PVC has no UID')
  await saveCopy()
  const image = string(object(arr(spec(plan.resources.desiredPod).containers)[0]).image)
  if (!image) throw new Error('Kafka image missing from SPS desired pod')
  const copier = marked(copierPod(plan, image), journal.operationId)
  let observedCopier = await getMaybe(run, options, 'pod', nameOf(copier)!)
  if (!observedCopier) {
    if (journal.copyPodUid) throw new Error('recorded copy Pod is missing before copy receipt')
    await apply(run, options, copier)
    observedCopier = await get(run, options, 'pod', nameOf(copier)!)
  }
  assertOwnedResource(observedCopier, copier, journal.operationId, journal.copyPodUid)
  journal.copyPodUid = uidOf(observedCopier)
  if (!journal.copyPodUid) throw new Error('copy Pod has no UID')
  await saveCopy()
  await wait(run, options, [
    '--for=jsonpath={.status.phase}=Bound',
    'pvc/' + nameOf(temp),
    '--timeout=' + options.timeoutSeconds + 's',
  ])
  bound = await get(run, options, 'pvc', nameOf(temp)!)
  assertOwnedResource(bound, temp, journal.operationId, journal.tempPvcUid)
  const targetAfterTemp = await get(run, options, 'pv', plan.targetPv, false)
  assertUid(targetAfterTemp, uidOf(plan.resources.targetPv), 'target PV')
  assertTempBinding(targetAfterTemp, plan, { name: nameOf(temp)!, uid: journal.tempPvcUid })
  await waitForCopyPod(run, options, nameOf(copier)!)
  assertUid(await get(run, options, 'pod', nameOf(copier)!), journal.copyPodUid, 'copy Pod')
  const logs = (await run(kube(options, ['logs', nameOf(copier)!]))).stdout
  if (!logs.includes('COPY_VERIFIED')) throw new Error('copy job did not emit COPY_VERIFIED')
  const next: Receipt = {
    ...receipt,
    phase: 'copied',
    updatedAt: new Date().toISOString(),
    tempPvc: { name: nameOf(temp)!, uid: journal.tempPvcUid },
    copyPod: { name: nameOf(copier)!, uid: journal.copyPodUid, logs },
  }
  await save(receiptPath(options), next as unknown as Json)
  await cleanupCopyPod(run, options, next)
  return next
}

const runRebind = async (run: Runner, options: Options) => {
  await operatorStopped(run, options)
  let receipt = await loadReceipt(options)
  const recordedTemp = receipt.tempPvc
  if (receipt.phase === 'rebound' || receipt.phase === 'started') return receipt
  if (receipt.phase !== 'copied' || !recordedTemp) throw new Error('copy receipt is required before rebind')
  await cleanupCopyPod(run, options, receipt)
  const plan = receipt.plan
  const sourcePvcUid = uidOf(plan.resources.sourcePvc)
  const sourcePvUid = uidOf(plan.resources.sourcePv)
  const targetPvUid = uidOf(plan.resources.targetPv)
  if (!sourcePvcUid || !sourcePvUid || !targetPvUid) throw new Error('plan is missing binding UIDs')
  const identities = await verifyIdentity(run, options, plan, false)
  const temp = await getMaybe(run, options, 'pvc', recordedTemp.name)
  if (temp) {
    assertUid(temp, recordedTemp.uid, 'temporary PVC')
    if (string(spec(temp).volumeName) !== plan.targetPv) throw new Error('temporary PVC target changed')
  } else if (receipt.rebind?.stage !== 'pv-swapped' || !receipt.rebind.finalPvcUid) {
    throw new Error('temporary PVC is missing before the final rebind stage')
  }

  let journal: RebindJournal
  const recordedJournal = receipt.rebind
  if (recordedJournal) {
    assertJournal(receipt, recordedJournal)
    journal = recordedJournal
  } else {
    assertUid(identities.sourcePvc, sourcePvcUid, 'source PVC')
    const target = identities.targetPv
    assertUid(target, targetPvUid, 'target PV')
    assertTempBinding(target, plan, recordedTemp)
    journal = {
      stage: 'armed',
      sourcePvcUid,
      sourcePvUid,
      targetPvUid,
      tempPvcUid: recordedTemp.uid,
      operationId: randomUUID(),
    }
    receipt = { ...receipt, updatedAt: new Date().toISOString(), rebind: journal }
    await save(receiptPath(options), receipt as unknown as Json)
  }

  const saveJournal = async (stage: RebindStage, finalPvcUid?: string) => {
    const nextJournal: RebindJournal = {
      ...journal,
      stage,
      ...(finalPvcUid === undefined ? {} : { finalPvcUid }),
    }
    journal = nextJournal
    receipt = { ...receipt, updatedAt: new Date().toISOString(), rebind: nextJournal }
    await save(receiptPath(options), receipt as unknown as Json)
  }

  const currentTarget = async () => {
    const target = await get(run, options, 'pv', plan.targetPv, false)
    assertUid(target, journal.targetPvUid, 'target PV')
    if (string(spec(target).persistentVolumeReclaimPolicy) !== 'Retain') throw new Error('target PV lost Retain guard')
    return target
  }

  const currentSource = async () => getMaybe(run, options, 'pvc', plan.sourcePvc)

  if (journal.stage === 'armed') {
    const source = await currentSource()
    if (source) {
      assertUid(source, journal.sourcePvcUid, 'source PVC')
      const target = await currentTarget()
      assertTempBinding(target, plan, recordedTemp)
      const beforeDelete = await currentSource()
      assertUid(beforeDelete, journal.sourcePvcUid, 'source PVC')
      await run(kube(options, ['delete', 'pvc', plan.sourcePvc, '--wait=true']))
      if (await currentSource()) throw new Error('source PVC still exists after delete')
    }
    const sourcePv = await get(run, options, 'pv', plan.sourcePv, false)
    assertUid(sourcePv, journal.sourcePvUid, 'source PV')
    if (string(spec(sourcePv).persistentVolumeReclaimPolicy) !== 'Retain')
      throw new Error('source PV lost Retain guard')
    assertTempBinding(await currentTarget(), plan, recordedTemp)
    await saveJournal('source-deleted')
  }

  let finalPvc = await currentSource()
  if (journal.stage === 'source-deleted') {
    if (finalPvc) {
      if (uidOf(finalPvc) === journal.sourcePvcUid) throw new Error('old source PVC still exists after delete boundary')
      assertFinalPvc(finalPvc, plan, journal.operationId, journal.finalPvcUid)
    } else {
      if (journal.finalPvcUid) throw new Error('recorded final PVC is missing')
      assertTempBinding(await currentTarget(), plan, recordedTemp)
      await apply(run, options, sanitizedOriginalPvc(plan, journal.operationId))
      finalPvc = await currentSource()
      if (!finalPvc) throw new Error('new PVC was not observed after create')
      assertFinalPvc(finalPvc, plan, journal.operationId)
    }
    const finalUid = uidOf(finalPvc)
    if (!finalUid) throw new Error('new PVC has no UID')
    await saveJournal('pvc-created', finalUid)
  } else if (journal.stage === 'pvc-created') {
    if (!journal.finalPvcUid) throw new Error('pvc-created journal has no final PVC UID')
    if (!finalPvc) throw new Error('recorded final PVC is missing')
    assertFinalPvc(finalPvc, plan, journal.operationId, journal.finalPvcUid)
  } else if (journal.stage !== 'pv-swapped') {
    throw new Error('invalid rebind journal stage')
  }

  if (journal.stage === 'pvc-created') {
    const finalUid = journal.finalPvcUid
    if (!finalUid) throw new Error('new PVC UID is missing')
    const target = await currentTarget()
    const targetClaim = claimIdentity(object(spec(target).claimRef))
    if (targetClaim.uid === journal.tempPvcUid) {
      const replacement = JSON.stringify([
        { op: 'test', path: '/metadata/uid', value: journal.targetPvUid },
        { op: 'test', path: '/spec/claimRef/uid', value: journal.tempPvcUid },
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
    } else if (targetClaim.uid !== finalUid) {
      throw new Error('target PV has a foreign claim before atomic handoff')
    }
    const afterSwap = await currentTarget()
    const finalClaim = claimIdentity(object(spec(afterSwap).claimRef))
    if (finalClaim.uid !== finalUid || finalClaim.name !== plan.sourcePvc || finalClaim.namespace !== plan.namespace)
      throw new Error('target PV final claim mismatch')
    await saveJournal('pv-swapped', finalUid)
  }

  const rebound = await currentSource()
  if (!rebound || !journal.finalPvcUid) throw new Error('final PVC disappeared before completion')
  assertFinalPvc(rebound, plan, journal.operationId, journal.finalPvcUid)
  const boundTarget = await currentTarget()
  const boundClaim = claimIdentity(object(spec(boundTarget).claimRef))
  if (
    boundClaim.uid !== journal.finalPvcUid ||
    boundClaim.name !== plan.sourcePvc ||
    boundClaim.namespace !== plan.namespace
  )
    throw new Error('target PV final binding changed')
  await wait(run, options, [
    '--for=jsonpath={.status.phase}=Bound',
    'pvc/' + plan.sourcePvc,
    '--timeout=' + options.timeoutSeconds + 's',
  ])
  const finalBound = await get(run, options, 'pvc', plan.sourcePvc)
  assertFinalPvc(finalBound, plan, journal.operationId, journal.finalPvcUid)
  const tempBeforeDelete = await getMaybe(run, options, 'pvc', recordedTemp.name)
  if (tempBeforeDelete) {
    assertUid(tempBeforeDelete, recordedTemp.uid, 'temporary PVC')
    await run(kube(options, ['delete', 'pvc', recordedTemp.name, '--wait=true']))
    if (await getMaybe(run, options, 'pvc', recordedTemp.name))
      throw new Error('temporary PVC still exists after delete')
  }
  const next: Receipt = {
    ...receipt,
    phase: 'rebound',
    updatedAt: new Date().toISOString(),
    finalPvcUid: journal.finalPvcUid,
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
  let journal = receipt.start
  if (!journal) {
    if (await getMaybe(run, options, 'pod', plan.pod)) throw new Error('Kafka pod already exists before startup intent')
    if (!receipt.finalPvcUid) throw new Error('final PVC UID is missing')
    journal = { operationId: randomUUID(), finalPvcUid: receipt.finalPvcUid }
    await save(receiptPath(options), { ...receipt, start: journal } as unknown as Json)
  }
  if (journal.finalPvcUid !== receipt.finalPvcUid) throw new Error('startup PVC identity changed')
  const desiredPod = marked(cleanPod(plan), journal.operationId)
  let pod = await getMaybe(run, options, 'pod', plan.pod)
  if (!pod) {
    if (journal.podUid) throw new Error('recorded startup Pod is missing')
    await apply(run, options, desiredPod)
    pod = await get(run, options, 'pod', plan.pod)
  }
  assertOwnedResource(pod, desiredPod, journal.operationId, journal.podUid)
  journal.podUid = uidOf(pod)
  if (!journal.podUid) throw new Error('startup Pod has no UID')
  await save(receiptPath(options), { ...receipt, start: journal } as unknown as Json)
  await wait(run, options, ['--for=condition=Ready', 'pod/' + plan.pod, '--timeout=' + options.timeoutSeconds + 's'])
  const readyPod = await get(run, options, 'pod', plan.pod)
  assertOwnedResource(readyPod, desiredPod, journal.operationId, journal.podUid)
  const next: Receipt = { ...receipt, start: journal, phase: 'started', updatedAt: new Date().toISOString() }
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
      if (existing.phase !== 'planned' || existing.copy)
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
