import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ArtifactStorageError, getS3ObjectTail } from '../../artifact-storage'
import { asRecord, asString, readNested } from '../primitives'
import { RESOURCE_MAP, type KubernetesClient } from '../kube-types'
import type { PrimitivesStore } from '../primitives-store'
import { readRunArtifactStorage } from '../run-artifact-storage'
import { postAgentRunsHandler } from '../v1/agent-runs'
import { getAgentRunHandler, cancelAgentRunHandler } from '../v1/run-read'
import { getAgentRunLogsHandler } from '../v1/agent-run-logs'
import type { AgentRunsApiDependencies } from '../v1/agent-runs-dependencies'
import { relayRunTools, type RelayRunTool, type Invocation, type Target } from './contract'
import type { Submission, SubmissionStore } from './store'

export type RelayRunsDependencies = {
  submissions: SubmissionStore
  primitives: () => Pick<PrimitivesStore, 'ready' | 'close' | 'getAgentRunByDeliveryId' | 'createAgentRun'>
  kube: Pick<KubernetesClient, 'get'>
  submit: (request: Request) => Promise<Response>
  read: (id: string, request: Request) => Promise<Response>
  cancel: (id: string, request: Request) => Promise<Response>
  logs: (request: Request, projectionId: string) => Promise<Response>
  result: (submission: Submission, target: Target) => Promise<unknown>
}
const jsonObject = async (response: Response) => {
  const value: unknown = await response.json()
  const object = asRecord(value)
  if (!response.ok || !object) throw new Error(`Agents request failed (${response.status})`)
  return object
}
const statusView = (submission: Submission, value: Record<string, unknown>) => {
  const record = asRecord(value.agentRun) ?? value
  const resource = asRecord(value.resource) ?? asRecord(readNested(record, ['payload', 'resource'])) ?? {}
  const status = asRecord(resource.status) ?? {}
  const runner = asRecord(status.runner) ?? {}
  return {
    runId: submission.operation_id,
    status: asString(record.status) ?? asString(status.phase) ?? 'Pending',
    createdAt: submission.created_at,
    progress: asRecord(runner.telemetry),
    result: asRecord(runner.result),
    conditions: Array.isArray(status.conditions) ? status.conditions : [],
  }
}
const unresolved = (submission: Submission) => ({
  runId: submission.operation_id,
  status: submission.rejection ? 'Rejected' : 'Unconfirmed',
  message: submission.rejection
    ? 'Agents rejected the submission.'
    : 'Submission outcome is not yet confirmed. Observe this run again; do not start it again.',
})

export const createRelayRunsService = (deps: RelayRunsDependencies) => {
  const observe = async (submission: Submission, target: Target): Promise<string | null> => {
    if (
      readNested(submission.request_payload, ['namespace']) !== target.namespace ||
      readNested(submission.request_payload, ['metadata', 'annotations', 'relay.proompteng.ai/namespace-uid']) !==
        target.namespaceUid
    )
      throw new Error('submitted target identity changed')
    if (submission.projection_id) return submission.projection_id
    if (submission.rejection) return null
    const store = deps.primitives()
    try {
      await store.ready
      const existing = await store.getAgentRunByDeliveryId(submission.operation_id)
      if (existing) {
        await deps.submissions.accepted(submission.operation_id, existing.id)
        return existing.id
      }
      // Observing an uncertain submission may repair its projection, never create a Kubernetes run.
      const resource = await deps.kube.get(RESOURCE_MAP.AgentRun, submission.run_name, target.namespace)
      if (!resource) return null
      if (
        readNested(resource, ['metadata', 'annotations', 'relay.proompteng.ai/request-hash']) !==
          submission.request_hash ||
        readNested(resource, ['metadata', 'annotations', 'relay.proompteng.ai/target']) !== target.id
      )
        throw new Error('submitted run identity changed')
      const record = await store.createAgentRun({
        agentName: target.agent,
        deliveryId: submission.operation_id,
        provider: 'job',
        status: asString(readNested(resource, ['status', 'phase'])) ?? 'Pending',
        externalRunId: submission.run_name,
        payload: { request: submission.request_payload, resource },
      })
      await deps.submissions.accepted(submission.operation_id, record.id)
      return record.id
    } finally {
      await store.close()
    }
  }
  const get = async (runId: string, target: Target) => {
    const submission = await deps.submissions.get(runId, target.workspaceId, target.id)
    if (!submission) throw new Error('run not found in this target')
    return submission
  }
  const read = async (submission: Submission, target: Target) => {
    const id = await observe(submission, target)
    if (!id) return unresolved(submission)
    return statusView(
      submission,
      await jsonObject(
        await deps.read(id, new Request(`http://agents/v1/agent-runs/${id}?namespace=${target.namespace}`)),
      ),
    )
  }
  return {
    call: async (name: RelayRunTool, input: unknown, invocation: Invocation, target: Target): Promise<unknown> => {
      if (invocation.action !== relayRunTools[name].action || invocation.resources[0]?.id !== target.id)
        throw new Error('authorized invocation does not match this operation or target')
      const namespace = await deps.kube.get('namespace', target.namespace, '')
      if (readNested(namespace, ['metadata', 'uid']) !== target.namespaceUid)
        throw new Error('target namespace identity changed')
      switch (name) {
        case 'start_run': {
          const args = relayRunTools.start_run.schema.parse(input)
          const runName = `relay-${invocation.operationId}`
          const requestHash = createHash('sha256').update(JSON.stringify({ target, args })).digest('hex')
          const payload = {
            namespace: target.namespace,
            agentRef: { name: target.agent },
            implementation: { text: args.task },
            ...(args.tokenBudget ? { goal: { objective: args.task, tokenBudget: args.tokenBudget } } : {}),
            metadata: {
              name: runName,
              annotations: {
                'relay.proompteng.ai/request-hash': requestHash,
                'relay.proompteng.ai/target': target.id,
                'relay.proompteng.ai/namespace-uid': target.namespaceUid,
              },
            },
            runtime: { type: 'job', config: { activeDeadlineSeconds: target.timeoutSeconds } },
            parameters: {
              repository: target.repository,
              base: target.base,
              head: `codex/relay/${invocation.operationId}`,
              stage: 'implementation',
              artifactKey: `relay/${target.workspaceId}/${invocation.operationId}/result.json`,
            },
            vcsRef: { name: target.vcsRef },
            vcsPolicy: { required: true, mode: 'read-write' },
            policy: { secretBindingRef: target.secretBindingRef },
            secrets: target.secrets,
            ttlSecondsAfterFinished: 86400,
          }
          const reserved = await deps.submissions.reserve({
            operation_id: invocation.operationId,
            workspace_id: target.workspaceId,
            target_id: target.id,
            client_service: invocation.clientService,
            actor: invocation.actor,
            authorization_receipt_id: invocation.authorizationReceiptId,
            request_hash: requestHash,
            request_payload: payload,
            run_name: runName,
          })
          if (!reserved.created) return read(reserved.submission, target)
          const response = await deps.submit(
            new Request('http://agents/v1/agent-runs', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'idempotency-key': invocation.operationId },
              body: JSON.stringify(payload),
            }),
          )
          if (!response.ok) {
            // Transport/server failures can occur after acceptance. Only admission rejections are definitive.
            if ([400, 401, 403, 422, 429].includes(response.status))
              await deps.submissions.rejected(
                invocation.operationId,
                response.status,
                'AgentRun admission rejected the request',
              )
            throw new Error(
              `Run ${invocation.operationId} submission returned ${response.status}; use get_run to observe it, do not resubmit`,
            )
          }
          const result = await jsonObject(response)
          const id = asString(readNested(result, ['agentRun', 'id']))
          if (!id) throw new Error(`Run ${invocation.operationId} submission reply has no projection; use get_run`)
          await deps.submissions.accepted(invocation.operationId, id)
          return statusView(reserved.submission, result)
        }
        case 'list_runs': {
          const args = relayRunTools.list_runs.schema.parse(input)
          const rows = await deps.submissions.list(target.workspaceId, target.id, args.limit)
          // Listing is a bounded database snapshot; get_run refreshes Kubernetes/worker progress.
          return {
            runs: rows.map((row) => ({
              runId: row.operation_id,
              createdAt: row.created_at,
              status: row.rejection ? 'Rejected' : (row.phase ?? (row.projection_id ? 'Accepted' : 'Unconfirmed')),
            })),
          }
        }
        case 'get_run':
          return read(await get(relayRunTools.get_run.schema.parse(input).runId, target), target)
        case 'read_logs': {
          const args = relayRunTools.read_logs.schema.parse(input)
          const submission = await get(args.runId, target)
          const id = await observe(submission, target)
          if (!id) return unresolved(submission)
          const value = await jsonObject(
            await deps.logs(
              new Request(
                `http://agents/logs?namespace=${target.namespace}&name=${submission.run_name}&tailLines=${args.lines}`,
              ),
              id,
            ),
          )
          return {
            runId: args.runId,
            logs: value.logs,
            truncated: value.truncated ?? false,
            source: value.source ?? 'pod',
          }
        }
        case 'get_result': {
          const submission = await get(relayRunTools.get_result.schema.parse(input).runId, target)
          const state = await read(submission, target)
          if (!['Succeeded', 'Failed', 'Cancelled', 'needs_iteration', 'needs_human'].includes(state.status))
            return state
          const result = await deps.result(submission, target)
          return {
            ...state,
            result,
            ...(result === null ? { message: 'No retained final response is available for this run.' } : {}),
          }
        }
        case 'cancel_run': {
          const submission = await get(relayRunTools.cancel_run.schema.parse(input).runId, target)
          const id = await observe(submission, target)
          if (!id) return unresolved(submission)
          return statusView(
            submission,
            await jsonObject(
              await deps.cancel(
                id,
                new Request(`http://agents/v1/agent-runs/${id}?namespace=${target.namespace}`, { method: 'DELETE' }),
              ),
            ),
          )
        }
      }
    },
  }
}

export const createRelayRunsDependencies = (options: {
  submissions: SubmissionStore
  primitives: () => PrimitivesStore
  kube: KubernetesClient
  submission: AgentRunsApiDependencies
}): RelayRunsDependencies => {
  const readDeps = { storeFactory: options.primitives, kubeClient: options.kube }
  return {
    submissions: options.submissions,
    primitives: options.primitives,
    kube: options.kube,
    submit: (request) => postAgentRunsHandler(request, options.submission),
    read: (id, request) => getAgentRunHandler(id, request, readDeps),
    cancel: (id, request) => cancelAgentRunHandler(id, request, readDeps),
    logs: async (request, id) => {
      const store = options.primitives()
      try {
        await store.ready
        const record = await store.getAgentRunById(id)
        if (!record) throw new Error('run not found')
        return await getAgentRunLogsHandler(request, {
          ...readDeps,
          record,
          maxBytes: 131072,
          storeFactory: options.primitives,
        })
      } finally {
        await store.close()
      }
    },
    result: async (submission, target) => {
      const config = await readRunArtifactStorage(options.kube, target.namespace, target.secrets, process.env)
      const key = z
        .string()
        .min(1)
        .parse(readNested(submission.request_payload, ['parameters', 'artifactKey']))
      const result = await getS3ObjectTail({ config, key, fetch, now: new Date(), maxBytes: 196_608 }).catch(
        (error: unknown) => {
          if (error instanceof ArtifactStorageError && error.status === 404) return null
          throw error
        },
      )
      if (!result) return null
      if (result.truncated) throw new Error('retained result exceeds its byte budget')
      return z
        .object({ responseText: z.string().max(64_000), responseTruncated: z.boolean() })
        .parse(JSON.parse(result.text))
    },
  }
}
