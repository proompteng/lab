// Decode only the Kubernetes fields the CLI uses. Keep raw custom objects for structured output.
import * as Schema from 'effect/Schema'

const {
  Array: array,
  Boolean: boolean,
  Int: int,
  Record: record,
  String: string,
  Struct: struct,
  optionalKey: opt,
} = Schema
const strings = record(string, string)

const owner = struct({ kind: string, name: string, uid: opt(string) })
const metadata = struct({
  name: Schema.NonEmptyString,
  namespace: opt(string),
  uid: opt(string),
  creationTimestamp: opt(string),
  deletionTimestamp: opt(string),
  generation: opt(int),
  labels: opt(strings),
  ownerReferences: opt(array(owner)),
})

const condition = struct({ type: string, status: string, reason: opt(string), message: opt(string) })
const podSpec = struct({
  nodeName: opt(string),
  serviceAccountName: opt(string),
  containers: opt(
    array(
      struct({
        name: string,
        image: opt(string),
        env: opt(array(struct({ name: string, value: opt(string), valueFrom: opt(Schema.Unknown) }))),
        volumeMounts: opt(
          array(
            struct({
              name: string,
              mountPath: string,
              readOnly: opt(boolean),
              subPath: opt(string),
              subPathExpr: opt(string),
            }),
          ),
        ),
      }),
    ),
  ),
  volumes: opt(
    array(
      struct({
        name: string,
        configMap: opt(struct({ name: opt(string) })),
        projected: opt(
          struct({
            sources: opt(array(struct({ serviceAccountToken: opt(struct({ audience: opt(string), path: string })) }))),
          }),
        ),
      }),
    ),
  ),
})

export const pod = struct({
  metadata,
  spec: opt(podSpec),
  status: opt(
    struct({
      phase: opt(string),
      containerStatuses: opt(
        array(
          struct({
            name: string,
            state: opt(
              struct({
                waiting: opt(Schema.Unknown),
                running: opt(struct({ startedAt: opt(string) })),
                terminated: opt(struct({ message: opt(string), startedAt: opt(string), finishedAt: opt(string) })),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
})
export type Pod = typeof pod.Type
export type PodSpec = typeof podSpec.Type

export const job = struct({
  metadata,
  spec: opt(struct({ completions: opt(int), suspend: opt(boolean), template: opt(struct({ spec: opt(podSpec) })) })),
  status: opt(
    struct({
      active: opt(int),
      ready: opt(int),
      succeeded: opt(int),
      conditions: opt(array(condition)),
    }),
  ),
})
export type Job = typeof job.Type

export const deployment = struct({
  metadata,
  spec: opt(struct({ replicas: opt(int), template: opt(struct({ spec: opt(podSpec) })) })),
  status: opt(struct({ readyReplicas: opt(int), availableReplicas: opt(int), observedGeneration: opt(int) })),
})
export type Deployment = typeof deployment.Type

export const crd = struct({ metadata, status: opt(struct({ conditions: opt(array(condition)) })) })
export const configMap = struct({ metadata, data: opt(strings) })
export type ConfigMap = typeof configMap.Type

export const node = struct({
  metadata,
  status: opt(struct({ nodeInfo: opt(struct({ architecture: opt(string) })), allocatable: opt(strings) })),
})
export type Node = typeof node.Type

export const lease = struct({
  metadata,
  spec: opt(struct({ holderIdentity: opt(string), renewTime: opt(string), leaseDurationSeconds: opt(int) })),
})

export const event = struct({
  metadata,
  involvedObject: owner,
  type: opt(string),
  reason: opt(string),
  message: opt(string),
  count: opt(int),
  lastTimestamp: opt(Schema.NullOr(string)),
  eventTime: opt(Schema.NullOr(string)),
  series: opt(struct({ lastObservedTime: opt(string), count: opt(int) })),
})

export const cnpgCluster = struct({
  metadata,
  spec: opt(struct({ instances: opt(int) })),
  status: opt(struct({ phase: opt(string), readyInstances: opt(int), conditions: opt(array(condition)) })),
})

const workflowRef = struct({ name: opt(string), uid: opt(string), namespace: opt(string) })
export const agentRun = struct({
  metadata,
  spec: opt(
    struct({
      agentRef: opt(struct({ name: string })),
      parameters: opt(strings),
      runtime: opt(struct({ type: opt(string) })),
      workflow: opt(
        struct({ steps: opt(array(struct({ name: string, retries: opt(int), loop: opt(Schema.Unknown) }))) }),
      ),
    }),
  ),
  status: opt(
    struct({
      phase: opt(string),
      startedAt: opt(string),
      finishedAt: opt(string),
      runtimeRef: opt(struct({ ...workflowRef.fields, type: opt(string), stepName: opt(string) })),
      conditions: opt(array(condition)),
      vcs: opt(struct({ baseBranch: opt(string), headBranch: opt(string) })),
      workflow: opt(
        struct({
          steps: opt(array(struct({ name: string, phase: opt(string), attempt: opt(int), jobRef: opt(workflowRef) }))),
        }),
      ),
    }),
  ),
})
export type AgentRun = typeof agentRun.Type

export const rawObject = record(string, Schema.Unknown)
export const rawList = Schema.StructWithRest(struct({ items: array(rawObject) }), [rawObject])
