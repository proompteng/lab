import { randomUUID } from 'node:crypto'
import { create, toBinary } from '@bufbuild/protobuf'
import { type CallOptions, Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Context, Effect } from 'effect'
import * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'

import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from './client/headers'
import { type InterceptorBuilder, makeDefaultInterceptorBuilder, type TemporalInterceptor } from './client/interceptors'
import type { TemporalRpcRetryPolicy } from './client/retries'
import {
  buildCancelRequest,
  buildPollWorkflowUpdateRequest,
  buildQueryRequest,
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
  buildUpdateWorkflowRequest,
  computeSignalRequestId,
  createSignalRequestEntropy,
  createUpdateRequestId,
  decodeMemoAttributes,
  decodeSearchAttributes,
  decodeUpdateOutcome,
  encodeMemoAttributes,
  encodeSearchAttributes,
} from './client/serialization'
import { buildTransportOptions, type ClosableTransport, normalizeTemporalAddress } from './client/transport'
import {
  createWorkflowHandle,
  type RetryPolicyOptions,
  type SignalWithStartOptions,
  type StartWorkflowOptions,
  type StartWorkflowResult,
  type TerminateWorkflowOptions,
  type WorkflowHandle,
  type WorkflowHandleMetadata,
  type WorkflowUpdateAwaitOptions,
  type WorkflowUpdateHandle,
  type WorkflowUpdateOptions,
  type WorkflowUpdateResult,
  type WorkflowUpdateStage,
} from './client/types'
import {
  buildCodecsFromConfig,
  createDefaultDataConverter,
  type DataConverter,
  decodePayloadsToValues,
} from './common/payloads'
import { loadTemporalConfig, type TemporalConfig } from './config'
import {
  type ClientInterceptorBuilder,
  makeDefaultClientInterceptors,
  runClientInterceptors,
} from './interceptors/client'
import type { TemporalInterceptor as ClientMiddleware, InterceptorContext, InterceptorKind } from './interceptors/types'
import { createObservabilityServices } from './observability'
import type { LogFields, Logger, LogLevel } from './observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from './observability/metrics'
import { CloudService } from './proto/temporal/api/cloud/cloudservice/v1/service_pb'
import {
  type Memo,
  type Payload,
  type SearchAttributes,
  type WorkflowExecution,
  WorkflowExecutionSchema,
} from './proto/temporal/api/common/v1/message_pb'
import type { QueryRejectCondition } from './proto/temporal/api/enums/v1/query_pb'
import { UpdateWorkflowExecutionLifecycleStage } from './proto/temporal/api/enums/v1/update_pb'
import { HistoryEventFilterType, VersioningBehavior } from './proto/temporal/api/enums/v1/workflow_pb'
import type { HistoryEvent } from './proto/temporal/api/history/v1/message_pb'
import {
  type AddSearchAttributesRequest,
  AddSearchAttributesRequestSchema,
  type AddSearchAttributesResponse,
  type CreateNexusEndpointRequest,
  CreateNexusEndpointRequestSchema,
  type CreateNexusEndpointResponse,
  type DeleteNexusEndpointRequest,
  DeleteNexusEndpointRequestSchema,
  type DeleteNexusEndpointResponse,
  type GetNexusEndpointRequest,
  GetNexusEndpointRequestSchema,
  type GetNexusEndpointResponse,
  type ListNexusEndpointsRequest,
  ListNexusEndpointsRequestSchema,
  type ListNexusEndpointsResponse,
  type ListSearchAttributesRequest,
  ListSearchAttributesRequestSchema,
  type ListSearchAttributesResponse,
  type RemoveSearchAttributesRequest,
  RemoveSearchAttributesRequestSchema,
  type RemoveSearchAttributesResponse,
  type UpdateNexusEndpointRequest,
  UpdateNexusEndpointRequestSchema,
  type UpdateNexusEndpointResponse,
} from './proto/temporal/api/operatorservice/v1/request_response_pb'
import { OperatorService } from './proto/temporal/api/operatorservice/v1/service_pb'
import {
  type BackfillRequest,
  BackfillRequestSchema,
  SchedulePatchSchema,
  type TriggerImmediatelyRequest,
  TriggerImmediatelyRequestSchema,
} from './proto/temporal/api/schedule/v1/message_pb'
import {
  type CreateScheduleRequest,
  CreateScheduleRequestSchema,
  type CreateScheduleResponse,
  type DeleteScheduleRequest,
  DeleteScheduleRequestSchema,
  type DeleteScheduleResponse,
  type DeleteWorkerDeploymentRequest,
  DeleteWorkerDeploymentRequestSchema,
  type DeleteWorkerDeploymentResponse,
  type DeleteWorkerDeploymentVersionRequest,
  DeleteWorkerDeploymentVersionRequestSchema,
  type DeleteWorkerDeploymentVersionResponse,
  type DescribeDeploymentRequest,
  DescribeDeploymentRequestSchema,
  type DescribeDeploymentResponse,
  type DescribeNamespaceRequest,
  DescribeNamespaceRequestSchema,
  DescribeNamespaceResponseSchema,
  type DescribeScheduleRequest,
  DescribeScheduleRequestSchema,
  type DescribeScheduleResponse,
  DescribeWorkerDeploymentRequestSchema,
  type DescribeWorkerDeploymentResponse,
  type DescribeWorkerRequest,
  DescribeWorkerRequestSchema,
  type DescribeWorkerResponse,
  type FetchWorkerConfigRequest,
  FetchWorkerConfigRequestSchema,
  type FetchWorkerConfigResponse,
  type GetCurrentDeploymentRequest,
  GetCurrentDeploymentRequestSchema,
  type GetCurrentDeploymentResponse,
  type GetDeploymentReachabilityRequest,
  GetDeploymentReachabilityRequestSchema,
  type GetDeploymentReachabilityResponse,
  type GetWorkerVersioningRulesRequest,
  GetWorkerVersioningRulesRequestSchema,
  type GetWorkerVersioningRulesResponse,
  GetWorkflowExecutionHistoryRequestSchema,
  type GetWorkflowExecutionHistoryResponse,
  type ListDeploymentsRequest,
  ListDeploymentsRequestSchema,
  type ListDeploymentsResponse,
  type ListScheduleMatchingTimesRequest,
  ListScheduleMatchingTimesRequestSchema,
  type ListScheduleMatchingTimesResponse,
  type ListSchedulesRequest,
  ListSchedulesRequestSchema,
  type ListSchedulesResponse,
  type ListWorkerDeploymentsRequest,
  ListWorkerDeploymentsRequestSchema,
  type ListWorkerDeploymentsResponse,
  type ListWorkersRequest,
  ListWorkersRequestSchema,
  type ListWorkersResponse,
  type PatchScheduleRequest,
  PatchScheduleRequestSchema,
  type PatchScheduleResponse,
  type PauseWorkflowExecutionRequest,
  PauseWorkflowExecutionRequestSchema,
  type PauseWorkflowExecutionResponse,
  type QueryWorkflowResponse,
  type ResetStickyTaskQueueRequest,
  ResetStickyTaskQueueRequestSchema,
  type ResetStickyTaskQueueResponse,
  type SetCurrentDeploymentRequest,
  SetCurrentDeploymentRequestSchema,
  type SetCurrentDeploymentResponse,
  SetWorkerDeploymentCurrentVersionRequestSchema,
  type SetWorkerDeploymentCurrentVersionResponse,
  type SetWorkerDeploymentManagerRequest,
  SetWorkerDeploymentManagerRequestSchema,
  type SetWorkerDeploymentManagerResponse,
  SetWorkerDeploymentRampingVersionRequestSchema,
  type SetWorkerDeploymentRampingVersionResponse,
  type SignalWithStartWorkflowExecutionResponse,
  type StartWorkflowExecutionResponse,
  type UnpauseWorkflowExecutionRequest,
  UnpauseWorkflowExecutionRequestSchema,
  type UnpauseWorkflowExecutionResponse,
  type UpdateScheduleRequest,
  UpdateScheduleRequestSchema,
  type UpdateScheduleResponse,
  type UpdateTaskQueueConfigRequest,
  UpdateTaskQueueConfigRequestSchema,
  type UpdateTaskQueueConfigResponse,
  type UpdateWorkerConfigRequest,
  UpdateWorkerConfigRequestSchema,
  type UpdateWorkerConfigResponse,
  type UpdateWorkerDeploymentVersionMetadataRequest,
  UpdateWorkerDeploymentVersionMetadataRequestSchema,
  type UpdateWorkerDeploymentVersionMetadataResponse,
  type UpdateWorkerVersioningRulesRequest,
  UpdateWorkerVersioningRulesRequestSchema,
  type UpdateWorkerVersioningRulesResponse,
  type UpdateWorkflowExecutionOptionsRequest,
  UpdateWorkflowExecutionOptionsRequestSchema,
  type UpdateWorkflowExecutionOptionsResponse,
} from './proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowService } from './proto/temporal/api/workflowservice/v1/service_pb'
import {
  DataConverterService,
  LoggerService,
  MetricsExporterService,
  MetricsService,
  TemporalConfigService,
  WorkflowServiceClientService,
} from './runtime/effect-layers'
import { createTypedSearchAttributes, type TypedSearchAttributes } from './search-attributes'

type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>
type OperatorServiceClient = ReturnType<typeof createClient<typeof OperatorService>>
type CloudServiceClient = ReturnType<typeof createClient<typeof CloudService>>

type WorkflowServiceMethodName = keyof WorkflowServiceClient
type WorkflowServiceRequest<T extends WorkflowServiceMethodName> = Parameters<WorkflowServiceClient[T]>[0]
type WorkflowServiceResponse<T extends WorkflowServiceMethodName> = Awaited<ReturnType<WorkflowServiceClient[T]>>

type OperatorServiceMethodName = keyof OperatorServiceClient
type OperatorServiceRequest<T extends OperatorServiceMethodName> = Parameters<OperatorServiceClient[T]>[0]
type OperatorServiceResponse<T extends OperatorServiceMethodName> = Awaited<ReturnType<OperatorServiceClient[T]>>

type CloudServiceMethodName = keyof CloudServiceClient
type CloudServiceRequest<T extends CloudServiceMethodName> = Parameters<CloudServiceClient[T]>[0]
type CloudServiceResponse<T extends CloudServiceMethodName> = Awaited<ReturnType<CloudServiceClient[T]>>

export interface TemporalClientCallOptions {
  readonly headers?: Record<string, string | ArrayBuffer | ArrayBufferView>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly retryPolicy?: Partial<TemporalRpcRetryPolicy>
  readonly queryRejectCondition?: QueryRejectCondition
}

export type BrandedTemporalClientCallOptions = TemporalClientCallOptions & CallOptionsMarker

export const temporalCallOptions = (options: TemporalClientCallOptions): BrandedTemporalClientCallOptions => {
  const copy = { ...options } as BrandedTemporalClientCallOptions & { __temporalCallOptions?: true }
  Object.defineProperty(copy, CALL_OPTIONS_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
  })
  Object.defineProperty(copy, '__temporalCallOptions', {
    value: true,
    enumerable: false,
    configurable: false,
  })
  return copy
}

export interface TemporalMemoHelpers {
  encode(input?: Record<string, unknown>): Promise<Memo | undefined>
  decode(memo?: Memo | null): Promise<Record<string, unknown> | undefined>
}

export interface TemporalSearchAttributeHelpers {
  encode(input?: Record<string, unknown>): Promise<SearchAttributes | undefined>
  decode(attributes?: SearchAttributes | null): Promise<Record<string, unknown> | undefined>
  typed<T>(schema: Schema.Schema<T>): TypedSearchAttributes<T>
}

export interface PauseScheduleInput {
  readonly namespace?: string
  readonly scheduleId: string
  readonly reason?: string
  readonly identity?: string
  readonly requestId?: string
}

export interface TriggerScheduleInput {
  readonly namespace?: string
  readonly scheduleId: string
  readonly trigger?: TriggerImmediatelyRequest
  readonly identity?: string
  readonly requestId?: string
}

export interface BackfillScheduleInput {
  readonly namespace?: string
  readonly scheduleId: string
  readonly backfillRequest: ReadonlyArray<BackfillRequest>
  readonly identity?: string
  readonly requestId?: string
}

export interface UnpauseScheduleInput {
  readonly namespace?: string
  readonly scheduleId: string
  readonly reason?: string
  readonly identity?: string
  readonly requestId?: string
}

export interface TemporalCloudClient {
  call<T extends CloudServiceMethodName>(
    method: T,
    request: CloudServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CloudServiceResponse<T>>
  getService(): CloudServiceClient
  updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void>
}

export interface TemporalWorkflowServiceClient {
  call<T extends WorkflowServiceMethodName>(
    method: T,
    request: WorkflowServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowServiceResponse<T>>
  getService(): WorkflowServiceClient
}

export interface TemporalOperatorServiceClient {
  call<T extends OperatorServiceMethodName>(
    method: T,
    request: OperatorServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<OperatorServiceResponse<T>>
  getService(): OperatorServiceClient
}

export interface TemporalRpcClients {
  readonly workflow: TemporalWorkflowServiceClient
  readonly operator: TemporalOperatorServiceClient
  readonly cloud: TemporalCloudClient
}

const DEFAULT_TLS_SUGGESTIONS = [
  'Verify TEMPORAL_TLS_CA_PATH, CERT_PATH, and KEY_PATH point to valid PEM files',
  'Ensure TEMPORAL_TLS_SERVER_NAME matches the certificate Subject Alternative Name',
  'Set TEMPORAL_ALLOW_INSECURE=1 only for trusted development clusters',
] as const

const buildCloudHeaders = (options: {
  apiKey?: string
  apiVersion?: string
  headers?: Record<string, string | ArrayBuffer | ArrayBufferView>
}): Record<string, string> => {
  const base = { ...createDefaultHeaders(options.apiKey) }
  if (options.apiVersion) {
    base['temporal-cloud-api-version'] = options.apiVersion
  }
  if (!options.headers) {
    return base
  }
  const normalized = normalizeMetadataHeaders(options.headers)
  return mergeHeaders(base, normalized)
}

export class TemporalTlsHandshakeError extends Error {
  override readonly cause?: unknown
  readonly suggestions: readonly string[]

  constructor(message: string, options: { cause?: unknown; suggestions?: readonly string[] } = {}) {
    super(message)
    this.name = 'TemporalTlsHandshakeError'
    this.cause = options.cause
    this.suggestions = options.suggestions ?? DEFAULT_TLS_SUGGESTIONS
  }
}

export interface TemporalWorkflowClient {
  start(options: StartWorkflowOptions, callOptions?: BrandedTemporalClientCallOptions): Promise<StartWorkflowResult>
  signal(
    handle: WorkflowHandle,
    signalName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<void>
  query(
    handle: WorkflowHandle,
    queryName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<unknown>
  terminate(
    handle: WorkflowHandle,
    options?: TerminateWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void>
  cancel(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void>
  signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
  update(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  awaitUpdate(
    handle: WorkflowUpdateHandle,
    options?: WorkflowUpdateAwaitOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  cancelUpdate(handle: WorkflowUpdateHandle): Promise<void>
  getUpdateHandle(handle: WorkflowHandle, updateId: string, firstExecutionRunId?: string): WorkflowUpdateHandle
  result<T = unknown>(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<T>
}

export interface TemporalScheduleClient {
  create(
    request: Omit<CreateScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CreateScheduleResponse>
  describe(
    request: Omit<DescribeScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeScheduleResponse>
  update(
    request: Omit<UpdateScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateScheduleResponse>
  patch(
    request: Omit<PatchScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse>
  list(
    request?: Omit<ListSchedulesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListSchedulesResponse>
  listMatchingTimes(
    request: Omit<ListScheduleMatchingTimesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListScheduleMatchingTimesResponse>
  delete(
    request: Omit<DeleteScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteScheduleResponse>
  trigger(request: TriggerScheduleInput, callOptions?: BrandedTemporalClientCallOptions): Promise<PatchScheduleResponse>
  backfill(
    request: BackfillScheduleInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse>
  pause(request: PauseScheduleInput, callOptions?: BrandedTemporalClientCallOptions): Promise<PatchScheduleResponse>
  unpause(request: UnpauseScheduleInput, callOptions?: BrandedTemporalClientCallOptions): Promise<PatchScheduleResponse>
}

export interface TemporalWorkflowOperationsClient {
  updateExecutionOptions(
    request: Omit<UpdateWorkflowExecutionOptionsRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkflowExecutionOptionsResponse>
  pauseExecution(
    request: Omit<PauseWorkflowExecutionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PauseWorkflowExecutionResponse>
  unpauseExecution(
    request: Omit<UnpauseWorkflowExecutionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UnpauseWorkflowExecutionResponse>
  resetStickyTaskQueue(
    request: Omit<ResetStickyTaskQueueRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ResetStickyTaskQueueResponse>
}

export interface TemporalWorkerOperationsClient {
  list(
    request?: Omit<ListWorkersRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListWorkersResponse>
  describe(
    request: Omit<DescribeWorkerRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeWorkerResponse>
  fetchConfig(
    request: Omit<FetchWorkerConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<FetchWorkerConfigResponse>
  updateConfig(
    request: Omit<UpdateWorkerConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerConfigResponse>
  updateTaskQueueConfig(
    request: Omit<UpdateTaskQueueConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateTaskQueueConfigResponse>
  getVersioningRules(
    request: Omit<GetWorkerVersioningRulesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetWorkerVersioningRulesResponse>
  updateVersioningRules(
    request: Omit<UpdateWorkerVersioningRulesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerVersioningRulesResponse>
}

export interface DescribeWorkerDeploymentInput {
  readonly namespace?: string
  readonly deploymentName: string
}

export interface SetWorkerDeploymentCurrentVersionInput {
  readonly namespace?: string
  readonly deploymentName: string
  readonly buildId: string
  readonly version?: string
  readonly conflictToken?: Uint8Array
  readonly identity?: string
  readonly ignoreMissingTaskQueues?: boolean
  readonly allowNoPollers?: boolean
}

export interface SetWorkerDeploymentRampingVersionInput {
  readonly namespace?: string
  readonly deploymentName: string
  readonly buildId: string
  readonly percentage: number
  readonly version?: string
  readonly conflictToken?: Uint8Array
  readonly identity?: string
  readonly ignoreMissingTaskQueues?: boolean
  readonly allowNoPollers?: boolean
}

export interface TemporalDeploymentClient {
  listWorkerDeployments(
    request?: Omit<ListWorkerDeploymentsRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListWorkerDeploymentsResponse>
  describeWorkerDeployment(
    request: DescribeWorkerDeploymentInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeWorkerDeploymentResponse>
  listDeployments(
    request?: Omit<ListDeploymentsRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListDeploymentsResponse>
  describeDeployment(
    request: Omit<DescribeDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeDeploymentResponse>
  getCurrentDeployment(
    request: Omit<GetCurrentDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetCurrentDeploymentResponse>
  setCurrentDeployment(
    request: Omit<SetCurrentDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetCurrentDeploymentResponse>
  getDeploymentReachability(
    request: Omit<GetDeploymentReachabilityRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetDeploymentReachabilityResponse>
  setWorkerDeploymentCurrentVersion(
    request: SetWorkerDeploymentCurrentVersionInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentCurrentVersionResponse>
  setWorkerDeploymentRampingVersion(
    request: SetWorkerDeploymentRampingVersionInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentRampingVersionResponse>
  updateWorkerDeploymentVersionMetadata(
    request: Omit<UpdateWorkerDeploymentVersionMetadataRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerDeploymentVersionMetadataResponse>
  deleteWorkerDeploymentVersion(
    request: Omit<DeleteWorkerDeploymentVersionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteWorkerDeploymentVersionResponse>
  deleteWorkerDeployment(
    request: Omit<DeleteWorkerDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteWorkerDeploymentResponse>
  setWorkerDeploymentManager(
    request: Omit<SetWorkerDeploymentManagerRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentManagerResponse>
}

export interface TemporalOperatorClient {
  addSearchAttributes(
    request: Omit<AddSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<AddSearchAttributesResponse>
  removeSearchAttributes(
    request: Omit<RemoveSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<RemoveSearchAttributesResponse>
  listSearchAttributes(
    request: Omit<ListSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListSearchAttributesResponse>
  createNexusEndpoint(
    request: CreateNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CreateNexusEndpointResponse>
  updateNexusEndpoint(
    request: UpdateNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateNexusEndpointResponse>
  deleteNexusEndpoint(
    request: DeleteNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteNexusEndpointResponse>
  getNexusEndpoint(
    request: GetNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetNexusEndpointResponse>
  listNexusEndpoints(
    request?: ListNexusEndpointsRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListNexusEndpointsResponse>
}

export interface TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  readonly schedules: TemporalScheduleClient
  readonly workflowOps: TemporalWorkflowOperationsClient
  readonly workerOps: TemporalWorkerOperationsClient
  readonly deployments: TemporalDeploymentClient
  readonly operator: TemporalOperatorClient
  readonly cloud: TemporalCloudClient
  readonly rpc: TemporalRpcClients
  readonly memo: TemporalMemoHelpers
  readonly searchAttributes: TemporalSearchAttributeHelpers
  startWorkflow(
    options: StartWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
  signalWorkflow(
    handle: WorkflowHandle,
    signalName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<void>
  queryWorkflow(
    handle: WorkflowHandle,
    queryName: string,
    ...args: [...unknown[], BrandedTemporalClientCallOptions | undefined]
  ): Promise<unknown>
  terminateWorkflow(
    handle: WorkflowHandle,
    options?: TerminateWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void>
  cancelWorkflow(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void>
  signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult>
  updateWorkflow(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  awaitWorkflowUpdate(
    handle: WorkflowUpdateHandle,
    options?: WorkflowUpdateAwaitOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult>
  cancelWorkflowUpdate(handle: WorkflowUpdateHandle): Promise<void>
  getWorkflowUpdateHandle(handle: WorkflowHandle, updateId: string, firstExecutionRunId?: string): WorkflowUpdateHandle
  describeNamespace(namespace?: string, callOptions?: BrandedTemporalClientCallOptions): Promise<Uint8Array>
  updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void>
  shutdown(): Promise<void>
}

type TemporalClientMetrics = {
  readonly operationCount: Counter
  readonly operationLatency: Histogram
  readonly operationErrors: Counter
}

const CALL_OPTIONS_MARKER = Symbol.for('temporal.bun.callOptions')

type CallOptionsMarker = {
  readonly [CALL_OPTIONS_MARKER]: true
}

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const TLS_ERROR_CODE_PREFIXES = ['ERR_TLS_', 'ERR_SSL_']
const TLS_ERROR_MESSAGE_HINTS = [/handshake/i, /certificate/i, /secure tls/i, /ssl/i]

const isAbortLikeError = (error: unknown): boolean =>
  (error instanceof Error && error.name === 'AbortError') ||
  (error instanceof ConnectError && error.code === Code.Canceled)

const normalizeUnknownError = (error: unknown): unknown => {
  const unwrap = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') {
      return value
    }

    if (value instanceof TemporalTlsHandshakeError || value instanceof ConnectError) {
      return value
    }

    const candidate = value as { cause?: unknown; error?: unknown; _tag?: string }

    if (candidate.cause !== undefined) {
      return unwrap(candidate.cause)
    }
    if (candidate.error !== undefined) {
      return unwrap(candidate.error)
    }

    if (candidate._tag === 'UnknownException') {
      return unwrap(candidate.cause ?? candidate.error ?? value)
    }

    const symbols = Object.getOwnPropertySymbols(value)
    for (const symbol of symbols) {
      const inner = (value as Record<symbol, unknown>)[symbol]
      const unwrapped = unwrap(inner)
      if (unwrapped !== inner) {
        return unwrapped
      }
    }

    return value
  }

  return unwrap(error)
}

const isCallOptionsCandidate = (value: unknown): value is BrandedTemporalClientCallOptions => {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (CALL_OPTIONS_MARKER in (value as Record<string | symbol, unknown>)) {
    return true
  }
  return (value as Record<string, unknown>).__temporalCallOptions === true
}

const unwrapTlsCause = (error: unknown): Error | undefined => {
  if (error instanceof TemporalTlsHandshakeError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof ConnectError && error.cause instanceof Error) {
    return error.cause
  }
  if (error instanceof Error) {
    return error
  }
  return undefined
}

const wrapRpcError = (error: unknown): unknown => {
  const cause = unwrapTlsCause(error)
  if (!cause) {
    return error
  }
  const code = (cause as NodeJS.ErrnoException).code
  if (typeof code === 'string' && TLS_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return new TemporalTlsHandshakeError(`Temporal TLS handshake failed (${code})`, { cause })
  }
  if (cause.message?.toLowerCase().includes('h2 is not supported')) {
    return new TemporalTlsHandshakeError('Temporal endpoint rejected TLS/HTTP2 handshakes', { cause })
  }
  if (TLS_ERROR_MESSAGE_HINTS.some((pattern) => pattern.test(cause.message))) {
    return new TemporalTlsHandshakeError('Temporal TLS handshake failed', { cause })
  }
  return error
}

export interface CreateTemporalClientOptions {
  config?: TemporalConfig
  namespace?: string
  identity?: string
  taskQueue?: string
  dataConverter?: DataConverter
  logger?: Logger
  metrics?: MetricsRegistry
  metricsExporter?: MetricsExporter
  interceptors?: TemporalInterceptor[]
  interceptorBuilder?: InterceptorBuilder
  clientInterceptors?: ClientMiddleware[]
  clientInterceptorBuilder?: ClientInterceptorBuilder
  tracingEnabled?: boolean
  workflowService?: WorkflowServiceClient
  operatorService?: OperatorServiceClient
  cloudService?: CloudServiceClient
  transport?: ClosableTransport
  cloudTransport?: ClosableTransport
  cloudAddress?: string
  cloudApiKey?: string
  cloudApiVersion?: string
  cloudHeaders?: Record<string, string | ArrayBuffer | ArrayBufferView>
}

export const createTemporalClient = async (
  options: CreateTemporalClientOptions = {},
): Promise<{ client: TemporalClient; config: TemporalConfig }> => {
  const config = options.config ?? (await loadTemporalConfig())
  const observability = await Effect.runPromise(
    createObservabilityServices(
      {
        logLevel: config.logLevel,
        logFormat: config.logFormat,
        metrics: config.metricsExporter,
      },
      {
        logger: options.logger,
        metricsRegistry: options.metrics,
        metricsExporter: options.metricsExporter,
      },
    ),
  )
  const { logger, metricsRegistry, metricsExporter } = observability
  let transport = options.transport
  let workflowService = options.workflowService
  let operatorService = options.operatorService
  let cloudTransport = options.cloudTransport
  let cloudService = options.cloudService
  let createdTransport: ClosableTransport | undefined
  let createdCloudTransport: ClosableTransport | undefined
  const cloudAddress = options.cloudAddress ?? config.cloudAddress

  if (!workflowService) {
    if (!transport) {
      const interceptorBuilder = options.interceptorBuilder ?? makeDefaultInterceptorBuilder()
      const defaultInterceptors = await Effect.runPromise(
        interceptorBuilder.build({
          namespace: options.namespace ?? config.namespace,
          identity: options.identity ?? config.workerIdentity,
          logger,
          metricsRegistry,
          metricsExporter,
        }),
      )
      const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
      const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
      const allInterceptors = [...defaultInterceptors, ...(options.interceptors ?? [])]
      const transportOptions = buildTransportOptions(baseUrl, config, allInterceptors)
      transport = createGrpcTransport(transportOptions) as ClosableTransport
      createdTransport = transport
    }

    if (!transport) {
      throw new Error('Temporal transport is not available')
    }

    workflowService = createClient(WorkflowService, transport)
  }

  if (!workflowService) {
    throw new Error('Temporal workflow service is not available')
  }

  if (!operatorService && transport) {
    operatorService = createClient(OperatorService, transport)
  }

  if (!cloudService) {
    if (!cloudTransport && cloudAddress) {
      const baseUrl = normalizeTemporalAddress(cloudAddress, true)
      const transportOptions = buildTransportOptions(baseUrl, config, [])
      cloudTransport = createGrpcTransport(transportOptions) as ClosableTransport
      createdCloudTransport = cloudTransport
    }
    if (cloudTransport) {
      cloudService = createClient(CloudService, cloudTransport)
    }
  }

  const dataConverter =
    options.dataConverter ??
    createDefaultDataConverter({
      payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
      logger,
      metricsRegistry,
    })

  const effect = makeTemporalClientEffect({
    ...options,
    config,
    logger,
    metrics: metricsRegistry,
    metricsExporter,
    workflowService,
    operatorService,
    cloudService,
    transport,
    cloudTransport,
    dataConverter,
    cloudHeaders: options.cloudHeaders,
  })

  try {
    return await Effect.runPromise(
      effect.pipe(
        Effect.provideService(TemporalConfigService, config),
        Effect.provideService(LoggerService, logger),
        Effect.provideService(MetricsService, metricsRegistry),
        Effect.provideService(MetricsExporterService, metricsExporter),
        Effect.provideService(WorkflowServiceClientService, workflowService),
        Effect.provideService(DataConverterService, dataConverter),
      ),
    )
  } catch (error) {
    await createdTransport?.close?.()
    await createdCloudTransport?.close?.()
    throw error
  }
}

export const makeTemporalClientEffect = (
  options: CreateTemporalClientOptions = {},
): Effect.Effect<
  { client: TemporalClient; config: TemporalConfig },
  unknown,
  | TemporalConfigService
  | LoggerService
  | MetricsService
  | MetricsExporterService
  | WorkflowServiceClientService
  | DataConverterService
> =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* TemporalConfigService)
    const namespace = options.namespace ?? config.namespace
    const identity = options.identity ?? config.workerIdentity
    const taskQueue = options.taskQueue ?? config.taskQueue
    const logger = options.logger ?? (yield* LoggerService)
    const metricsRegistry = options.metrics ?? (yield* MetricsService)
    const metricsExporter = options.metricsExporter ?? (yield* MetricsExporterService)
    const contextualDataConverter = yield* Effect.contextWith((context) =>
      Context.getOption(context, DataConverterService),
    )
    const dataConverter =
      options.dataConverter ??
      Option.getOrUndefined(contextualDataConverter) ??
      createDefaultDataConverter({
        payloadCodecs: buildCodecsFromConfig(config.payloadCodecs),
        logger,
        metricsRegistry,
      })
    const initialHeaders = createDefaultHeaders(config.apiKey)
    const cloudAddress = options.cloudAddress ?? config.cloudAddress
    const cloudApiKey = options.cloudApiKey ?? config.cloudApiKey
    const cloudApiVersion = options.cloudApiVersion ?? config.cloudApiVersion
    const initialCloudHeaders = buildCloudHeaders({
      apiKey: cloudApiKey,
      apiVersion: cloudApiVersion,
      headers: options.cloudHeaders,
    })
    const tracingEnabled = options.tracingEnabled ?? config.tracingInterceptorsEnabled ?? false
    const clientInterceptorBuilder: ClientInterceptorBuilder = options.clientInterceptorBuilder ?? {
      build: (input) => makeDefaultClientInterceptors(input),
    }
    const defaultClientInterceptors = yield* clientInterceptorBuilder.build({
      namespace,
      taskQueue,
      identity,
      logger,
      metricsRegistry,
      metricsExporter,
      retryPolicy: config.rpcRetryPolicy,
      tracingEnabled,
    })
    const clientInterceptors = [...defaultClientInterceptors, ...(options.clientInterceptors ?? [])]
    const workflowServiceFromContext = yield* Effect.contextWith((context) =>
      Context.getOption(context, WorkflowServiceClientService),
    )
    let workflowService = options.workflowService ?? Option.getOrUndefined(workflowServiceFromContext)
    let operatorService = options.operatorService
    let cloudService = options.cloudService
    let transport: ClosableTransport | undefined = options.transport
    let cloudTransport: ClosableTransport | undefined = options.cloudTransport

    if (!workflowService) {
      if (!transport) {
        const interceptorBuilder = options.interceptorBuilder ?? makeDefaultInterceptorBuilder()
        const defaultInterceptors = yield* interceptorBuilder.build({
          namespace,
          identity,
          logger,
          metricsRegistry,
          metricsExporter,
        })
        const allInterceptors = [...defaultInterceptors, ...(options.interceptors ?? [])]
        const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
        const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
        const transportOptions = buildTransportOptions(baseUrl, config, allInterceptors)
        transport = createGrpcTransport(transportOptions) as ClosableTransport
      }
      if (!transport) {
        throw new Error('Temporal transport is not available')
      }
      workflowService = createClient(WorkflowService, transport)
    }

    const clientMetrics = yield* Effect.promise(() => TemporalClientImpl.initMetrics(metricsRegistry))
    if (!workflowService) {
      throw new Error('Temporal workflow service is not available')
    }
    if (!operatorService && transport) {
      operatorService = createClient(OperatorService, transport)
    }

    if (!cloudService) {
      if (!cloudTransport && cloudAddress) {
        const baseUrl = normalizeTemporalAddress(cloudAddress, true)
        const transportOptions = buildTransportOptions(baseUrl, config, [])
        cloudTransport = createGrpcTransport(transportOptions) as ClosableTransport
      }
      if (cloudTransport) {
        cloudService = createClient(CloudService, cloudTransport)
      }
    }

    const client = new TemporalClientImpl({
      transport,
      cloudTransport,
      workflowService,
      operatorService,
      cloudService,
      config,
      namespace,
      identity,
      taskQueue,
      dataConverter,
      headers: initialHeaders,
      cloudHeaders: initialCloudHeaders,
      logger,
      metrics: clientMetrics,
      metricsExporter,
      clientInterceptors,
    })

    return { client, config }
  }) as Effect.Effect<
    { client: TemporalClient; config: TemporalConfig },
    unknown,
    TemporalConfigService | LoggerService | MetricsService | MetricsExporterService | WorkflowServiceClientService
  >

class TemporalClientImpl implements TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  readonly schedules: TemporalScheduleClient
  readonly workflowOps: TemporalWorkflowOperationsClient
  readonly workerOps: TemporalWorkerOperationsClient
  readonly deployments: TemporalDeploymentClient
  readonly operator: TemporalOperatorClient
  readonly cloud: TemporalCloudClient
  readonly rpc: TemporalRpcClients
  readonly memo: TemporalMemoHelpers
  readonly searchAttributes: TemporalSearchAttributeHelpers

  private readonly transport?: ClosableTransport
  private readonly cloudTransport?: ClosableTransport
  private readonly workflowService: WorkflowServiceClient
  private readonly operatorService?: OperatorServiceClient
  private readonly cloudService?: CloudServiceClient
  private readonly defaultIdentity: string
  private readonly defaultTaskQueue: string
  #logger: Logger
  #clientMetrics: TemporalClientMetrics
  #metricsExporter: MetricsExporter
  #clientInterceptors: ClientMiddleware[]
  #pendingUpdateControllers = new Map<string, Set<AbortController>>()
  #abortedUpdates = new Set<string>()
  private closed = false
  private headers: Record<string, string>
  private cloudHeaders: Record<string, string>

  static async initMetrics(registry: MetricsRegistry): Promise<TemporalClientMetrics> {
    const makeCounter = (name: string, description: string) => Effect.runPromise(registry.counter(name, description))
    const makeHistogram = (name: string, description: string) =>
      Effect.runPromise(registry.histogram(name, description))
    return {
      operationCount: await makeCounter('temporal_client_operations_total', 'Temporal client operation calls'),
      operationLatency: await makeHistogram(
        'temporal_client_operation_latency_ms',
        'Latency for Temporal client operations',
      ),
      operationErrors: await makeCounter('temporal_client_operation_errors_total', 'Temporal client operation errors'),
    }
  }

  constructor(handles: {
    transport?: ClosableTransport
    cloudTransport?: ClosableTransport
    workflowService: WorkflowServiceClient
    operatorService?: OperatorServiceClient
    cloudService?: CloudServiceClient
    config: TemporalConfig
    namespace: string
    identity: string
    taskQueue: string
    dataConverter: DataConverter
    headers: Record<string, string>
    cloudHeaders: Record<string, string>
    logger: Logger
    metrics: TemporalClientMetrics
    metricsExporter: MetricsExporter
    clientInterceptors: ClientMiddleware[]
  }) {
    this.transport = handles.transport
    this.cloudTransport = handles.cloudTransport
    this.workflowService = handles.workflowService
    this.operatorService = handles.operatorService
    this.cloudService = handles.cloudService
    this.config = handles.config
    this.namespace = handles.namespace
    this.defaultIdentity = handles.identity
    this.defaultTaskQueue = handles.taskQueue
    this.dataConverter = handles.dataConverter
    this.headers = { ...handles.headers }
    this.cloudHeaders = { ...handles.cloudHeaders }
    this.#logger = handles.logger
    this.#clientMetrics = handles.metrics
    this.#metricsExporter = handles.metricsExporter
    this.#clientInterceptors = handles.clientInterceptors
    this.memo = {
      encode: (input) => encodeMemoAttributes(this.dataConverter, input),
      decode: (memo) => decodeMemoAttributes(this.dataConverter, memo),
    }
    this.searchAttributes = {
      encode: (input) => encodeSearchAttributes(this.dataConverter, input),
      decode: (attributes) => decodeSearchAttributes(this.dataConverter, attributes),
      typed: (schema) => createTypedSearchAttributes(schema, this.dataConverter),
    }

    this.workflow = {
      start: (options, callOptions) => this.startWorkflow(options, callOptions),
      signal: (handle, signalName, ...args) => this.signalWorkflow(handle, signalName, ...args),
      query: (handle, queryName, ...args) => this.queryWorkflow(handle, queryName, ...args),
      terminate: (handle, options, callOptions) => this.terminateWorkflow(handle, options, callOptions),
      cancel: (handle, callOptions) => this.cancelWorkflow(handle, callOptions),
      signalWithStart: (options, callOptions) => this.signalWithStart(options, callOptions),
      update: (workflowHandle, updateOptions, callOptions) =>
        this.updateWorkflow(workflowHandle, updateOptions, callOptions),
      awaitUpdate: (updateHandle, options, callOptions) => this.awaitWorkflowUpdate(updateHandle, options, callOptions),
      cancelUpdate: (updateHandle) => this.cancelWorkflowUpdate(updateHandle),
      getUpdateHandle: (workflowHandle, updateId, firstExecutionRunId) =>
        this.getWorkflowUpdateHandle(workflowHandle, updateId, firstExecutionRunId),
      result: (handle, callOptions) => this.getWorkflowResult(handle, callOptions),
    }

    this.schedules = {
      create: (request, callOptions) => this.createSchedule(request, callOptions),
      describe: (request, callOptions) => this.describeSchedule(request, callOptions),
      update: (request, callOptions) => this.updateSchedule(request, callOptions),
      patch: (request, callOptions) => this.patchSchedule(request, callOptions),
      list: (request, callOptions) => this.listSchedules(request, callOptions),
      listMatchingTimes: (request, callOptions) => this.listScheduleMatchingTimes(request, callOptions),
      delete: (request, callOptions) => this.deleteSchedule(request, callOptions),
      trigger: (request, callOptions) => this.triggerSchedule(request, callOptions),
      backfill: (request, callOptions) => this.backfillSchedule(request, callOptions),
      pause: (request, callOptions) => this.pauseSchedule(request, callOptions),
      unpause: (request, callOptions) => this.unpauseSchedule(request, callOptions),
    }

    this.workflowOps = {
      updateExecutionOptions: (request, callOptions) => this.updateWorkflowExecutionOptions(request, callOptions),
      pauseExecution: (request, callOptions) => this.pauseWorkflowExecution(request, callOptions),
      unpauseExecution: (request, callOptions) => this.unpauseWorkflowExecution(request, callOptions),
      resetStickyTaskQueue: (request, callOptions) => this.resetStickyTaskQueue(request, callOptions),
    }

    this.workerOps = {
      list: (request, callOptions) => this.listWorkers(request, callOptions),
      describe: (request, callOptions) => this.describeWorker(request, callOptions),
      fetchConfig: (request, callOptions) => this.fetchWorkerConfig(request, callOptions),
      updateConfig: (request, callOptions) => this.updateWorkerConfig(request, callOptions),
      updateTaskQueueConfig: (request, callOptions) => this.updateTaskQueueConfig(request, callOptions),
      getVersioningRules: (request, callOptions) => this.getWorkerVersioningRules(request, callOptions),
      updateVersioningRules: (request, callOptions) => this.updateWorkerVersioningRules(request, callOptions),
    }

    this.deployments = {
      listWorkerDeployments: (request, callOptions) => this.listWorkerDeployments(request, callOptions),
      describeWorkerDeployment: (request, callOptions) => this.describeWorkerDeployment(request, callOptions),
      listDeployments: (request, callOptions) => this.listDeployments(request, callOptions),
      describeDeployment: (request, callOptions) => this.describeDeployment(request, callOptions),
      getCurrentDeployment: (request, callOptions) => this.getCurrentDeployment(request, callOptions),
      setCurrentDeployment: (request, callOptions) => this.setCurrentDeployment(request, callOptions),
      getDeploymentReachability: (request, callOptions) => this.getDeploymentReachability(request, callOptions),
      setWorkerDeploymentCurrentVersion: (request, callOptions) =>
        this.setWorkerDeploymentCurrentVersion(request, callOptions),
      setWorkerDeploymentRampingVersion: (request, callOptions) =>
        this.setWorkerDeploymentRampingVersion(request, callOptions),
      updateWorkerDeploymentVersionMetadata: (request, callOptions) =>
        this.updateWorkerDeploymentVersionMetadata(request, callOptions),
      deleteWorkerDeploymentVersion: (request, callOptions) => this.deleteWorkerDeploymentVersion(request, callOptions),
      deleteWorkerDeployment: (request, callOptions) => this.deleteWorkerDeployment(request, callOptions),
      setWorkerDeploymentManager: (request, callOptions) => this.setWorkerDeploymentManager(request, callOptions),
    }

    this.operator = {
      addSearchAttributes: (request, callOptions) => this.addSearchAttributes(request, callOptions),
      removeSearchAttributes: (request, callOptions) => this.removeSearchAttributes(request, callOptions),
      listSearchAttributes: (request, callOptions) => this.listSearchAttributes(request, callOptions),
      createNexusEndpoint: (request, callOptions) => this.createNexusEndpoint(request, callOptions),
      updateNexusEndpoint: (request, callOptions) => this.updateNexusEndpoint(request, callOptions),
      deleteNexusEndpoint: (request, callOptions) => this.deleteNexusEndpoint(request, callOptions),
      getNexusEndpoint: (request, callOptions) => this.getNexusEndpoint(request, callOptions),
      listNexusEndpoints: (request, callOptions) => this.listNexusEndpoints(request, callOptions),
    }

    this.cloud = {
      call: (method, request, callOptions) => this.callCloudService(method, request, callOptions),
      getService: () => this.#requireCloudService(),
      updateHeaders: (headers) => this.updateCloudHeaders(headers),
    }

    this.rpc = {
      workflow: {
        call: (method, request, callOptions) => this.callWorkflowService(method, request, callOptions),
        getService: () => this.workflowService,
      },
      operator: {
        call: (method, request, callOptions) => this.callOperatorService(method, request, callOptions),
        getService: () => this.#requireOperatorService(),
      },
      cloud: this.cloud,
    }
  }

  async startWorkflow(
    options: StartWorkflowOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
    const parsedOptions = sanitizeStartWorkflowOptions(options)
    return this.#instrumentOperation(
      'workflow.start',
      async () => {
        this.ensureOpen()
        const request = await buildStartWorkflowRequest(
          {
            options: parsedOptions,
            defaults: {
              namespace: this.namespace,
              identity: this.defaultIdentity,
              taskQueue: this.defaultTaskQueue,
            },
          },
          this.dataConverter,
        )

        const response = await this.executeRpc(
          'startWorkflow',
          (rpcOptions) => this.workflowService.startWorkflowExecution(request, rpcOptions),
          callOptions,
        )
        return this.toStartWorkflowResult(response, {
          workflowId: request.workflowId,
          namespace: request.namespace,
          firstExecutionRunId: response.started ? response.runId : undefined,
        })
      },
      {
        workflowId: parsedOptions.workflowId,
        taskQueue: options.taskQueue ?? this.defaultTaskQueue,
      },
    )
  }

  async signalWorkflow(handle: WorkflowHandle, signalName: string, ...rawArgs: unknown[]): Promise<void> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.signal',
      async () => {
        this.ensureOpen()
        const normalizedSignalName = ensureNonEmptyString(signalName, 'signalName')
        const { values, callOptions } = this.#splitArgsAndOptions(rawArgs)

        const identity = this.defaultIdentity
        const entropy = createSignalRequestEntropy()
        const requestId = await computeSignalRequestId(
          {
            namespace: resolvedHandle.namespace,
            workflowId: resolvedHandle.workflowId,
            runId: resolvedHandle.runId,
            firstExecutionRunId: resolvedHandle.firstExecutionRunId,
            signalName: normalizedSignalName,
            identity,
            args: values,
          },
          this.dataConverter,
          { entropy },
        )

        const request = await buildSignalRequest(
          {
            handle: resolvedHandle,
            signalName: normalizedSignalName,
            args: values,
            identity,
            requestId,
          },
          this.dataConverter,
        )

        await this.executeRpc(
          'signalWorkflow',
          (rpcOptions) => this.workflowService.signalWorkflowExecution(request, rpcOptions),
          callOptions,
        )
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, taskQueue: this.defaultTaskQueue },
    )
  }

  async queryWorkflow(handle: WorkflowHandle, queryName: string, ...rawArgs: unknown[]): Promise<unknown> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.query',
      async () => {
        this.ensureOpen()
        const { values, callOptions } = this.#splitArgsAndOptions(rawArgs)

        const request = await buildQueryRequest(resolvedHandle, queryName, values, this.dataConverter, {
          rejectCondition: callOptions?.queryRejectCondition,
        })
        const response = await this.executeRpc(
          'queryWorkflow',
          (rpcOptions) => this.workflowService.queryWorkflow(request, rpcOptions),
          callOptions,
        )

        return this.parseQueryResult(response)
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async terminateWorkflow(
    handle: WorkflowHandle,
    options: TerminateWorkflowOptions = {},
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<void> {
    return this.#instrumentOperation(
      'workflow.terminate',
      async () => {
        this.ensureOpen()
        const resolvedHandle = resolveHandle(this.namespace, handle)
        const parsedOptions = sanitizeTerminateWorkflowOptions(options)

        const request = await buildTerminateRequest(
          resolvedHandle,
          parsedOptions,
          this.dataConverter,
          this.defaultIdentity,
        )
        await this.executeRpc(
          'terminateWorkflow',
          (rpcOptions) => this.workflowService.terminateWorkflowExecution(request, rpcOptions),
          callOptions,
        )
      },
      { workflowId: handle.workflowId, runId: handle.runId },
    )
  }

  async cancelWorkflow(handle: WorkflowHandle, callOptions?: BrandedTemporalClientCallOptions): Promise<void> {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.cancel',
      async () => {
        this.ensureOpen()

        const request = buildCancelRequest(resolvedHandle, this.defaultIdentity)
        await this.executeRpc(
          'cancelWorkflow',
          (rpcOptions) => this.workflowService.requestCancelWorkflowExecution(request, rpcOptions),
          callOptions,
        )
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async getWorkflowResult<T = unknown>(
    handle: WorkflowHandle,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<T> {
    let resolvedHandle = resolveHandle(this.namespace, handle)
    return this.#instrumentOperation(
      'workflow.result',
      async () => {
        this.ensureOpen()
        while (true) {
          const execution: WorkflowExecution = create(WorkflowExecutionSchema, {
            workflowId: resolvedHandle.workflowId,
            ...(resolvedHandle.runId ? { runId: resolvedHandle.runId } : {}),
          })

          const request = create(GetWorkflowExecutionHistoryRequestSchema, {
            namespace: resolvedHandle.namespace ?? this.namespace,
            execution,
            maximumPageSize: 1,
            historyEventFilterType: HistoryEventFilterType.CLOSE_EVENT,
            waitNewEvent: true,
            skipArchival: true,
          })

          const response = await this.executeRpc(
            'getWorkflowExecutionHistory',
            (rpcOptions) => this.workflowService.getWorkflowExecutionHistory(request, rpcOptions),
            callOptions,
          )

          const closeEvent = this.#extractCloseEvent(response)
          if (!closeEvent || !closeEvent.attributes) {
            throw new Error('Workflow close event not found')
          }

          const attributes = closeEvent.attributes
          switch (attributes.case) {
            case 'workflowExecutionContinuedAsNewEventAttributes': {
              const nextRunId = attributes.value.newExecutionRunId
              if (!nextRunId) {
                throw new Error('Continue-as-new event missing newExecutionRunId')
              }
              resolvedHandle = { ...resolvedHandle, runId: nextRunId }
              continue
            }
            case 'workflowExecutionCompletedEventAttributes': {
              const payloads = attributes.value.result?.payloads ?? []
              const decoded = await this.dataConverter.fromPayloads(payloads)
              return (decoded.length <= 1 ? (decoded[0] as T) : (decoded as unknown as T)) ?? (undefined as T)
            }
            case 'workflowExecutionFailedEventAttributes': {
              const failure = await this.dataConverter.decodeFailurePayloads(attributes.value.failure)
              const error = await this.dataConverter.failureToError(failure)
              throw error ?? new Error('Workflow failed')
            }
            case 'workflowExecutionTimedOutEventAttributes':
              throw new Error('Workflow timed out')
            case 'workflowExecutionCanceledEventAttributes': {
              const details = attributes.value.details?.payloads ?? []
              const decoded = await this.dataConverter.fromPayloads(details)
              const detail = decoded.length <= 1 ? decoded[0] : decoded
              throw new Error(
                detail ? `Workflow canceled: ${JSON.stringify(detail)}` : 'Workflow canceled without details',
              )
            }
            case 'workflowExecutionTerminatedEventAttributes': {
              const reason = attributes.value.reason
              throw new Error(reason ? `Workflow terminated: ${reason}` : 'Workflow terminated')
            }
            default:
              throw new Error(`Unsupported workflow close event type: ${attributes.case}`)
          }
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId },
    )
  }

  async signalWithStart(
    options: SignalWithStartOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<StartWorkflowResult> {
    const startOptions = sanitizeStartWorkflowOptions(options)
    return this.#instrumentOperation(
      'workflow.signalWithStart',
      async () => {
        this.ensureOpen()
        const signalName = ensureNonEmptyString(options.signalName, 'signalName')
        const signalArgs = options.signalArgs ?? []
        if (!Array.isArray(signalArgs)) {
          throw new Error('signalArgs must be an array when provided')
        }

        const request = await buildSignalWithStartRequest(
          {
            options: {
              ...startOptions,
              signalName,
              signalArgs,
            },
            defaults: {
              namespace: this.namespace,
              identity: this.defaultIdentity,
              taskQueue: this.defaultTaskQueue,
            },
          },
          this.dataConverter,
        )

        const response = await this.executeRpc(
          'signalWithStartWorkflow',
          (rpcOptions) => this.workflowService.signalWithStartWorkflowExecution(request, rpcOptions),
          callOptions,
        )
        return this.toStartWorkflowResult(response, {
          workflowId: request.workflowId,
          namespace: request.namespace,
          firstExecutionRunId: response.started ? response.runId : undefined,
        })
      },
      { workflowId: startOptions.workflowId },
    )
  }

  async updateWorkflow(
    handle: WorkflowHandle,
    options: WorkflowUpdateOptions,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const parsedOptions = sanitizeWorkflowUpdateOptions(options)
    const updateId = parsedOptions.updateId ?? createUpdateRequestId()
    const waitStage = this.#stageToProto(parsedOptions.waitForStage)
    return this.#instrumentOperation(
      'workflow.update',
      async () => {
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const {
          options: mergedCallOptions,
          controller,
          cleanup,
        } = this.#prepareUpdateCallOptions(updateKey, callOptions)

        try {
          const request = await buildUpdateWorkflowRequest(
            {
              handle: resolvedHandle,
              namespace: this.namespace,
              identity: this.defaultIdentity,
              updateId,
              updateName: parsedOptions.updateName,
              args: parsedOptions.args,
              headers: parsedOptions.headers,
              waitStage,
              firstExecutionRunId: parsedOptions.firstExecutionRunId,
            },
            this.dataConverter,
          )

          let response = await this.executeRpc(
            'updateWorkflowExecution',
            (rpcOptions) => this.workflowService.updateWorkflowExecution(request, rpcOptions),
            mergedCallOptions,
          )

          while ((response.stage ?? UpdateWorkflowExecutionLifecycleStage.UNSPECIFIED) < waitStage) {
            response = await this.executeRpc(
              'updateWorkflowExecution',
              (rpcOptions) => this.workflowService.updateWorkflowExecution(request, rpcOptions),
              mergedCallOptions,
            )
          }

          const runId = response.updateRef?.workflowExecution?.runId || resolvedHandle.runId
          const updateHandle = this.#createWorkflowUpdateHandle(resolvedHandle, {
            updateId,
            runId,
            firstExecutionRunId: parsedOptions.firstExecutionRunId,
          })
          const stage = this.#stageFromProto(response.stage)
          const outcome = await decodeUpdateOutcome(this.dataConverter, response.outcome)
          return {
            handle: updateHandle,
            stage,
            outcome,
          }
        } finally {
          this.#releaseUpdateController(updateKey, controller)
          cleanup?.()
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, updateId },
    )
  }

  async awaitWorkflowUpdate(
    handle: WorkflowUpdateHandle,
    options: WorkflowUpdateAwaitOptions = {},
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowUpdateResult> {
    this.ensureOpen()
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const updateId = ensureNonEmptyString(handle.updateId, 'updateId')
    const waitStage = this.#stageToProto(options.waitForStage ?? 'completed')
    const firstExecutionRunIdOverride = ensureOptionalTrimmedString(
      options.firstExecutionRunId,
      'firstExecutionRunId',
      1,
    )
    const pollHandle: WorkflowHandle = {
      workflowId: resolvedHandle.workflowId,
      namespace: resolvedHandle.namespace,
      runId: resolvedHandle.runId,
      firstExecutionRunId: firstExecutionRunIdOverride ?? resolvedHandle.firstExecutionRunId,
    }
    return this.#instrumentOperation(
      'workflow.awaitUpdate',
      async () => {
        const request = buildPollWorkflowUpdateRequest({
          handle: pollHandle,
          namespace: this.namespace,
          identity: this.defaultIdentity,
          updateId,
          waitStage,
        })
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const {
          options: mergedCallOptions,
          controller,
          cleanup,
        } = this.#prepareUpdateCallOptions(updateKey, callOptions)

        const throwIfAborted = () => {
          if (controller.signal.aborted || this.#abortedUpdates.has(updateKey)) {
            this.#abortedUpdates.delete(updateKey)
            const abortError = new Error('Workflow update polling aborted')
            abortError.name = 'AbortError'
            throw abortError
          }
        }

        throwIfAborted()

        try {
          const response = await this.executeRpc(
            'pollWorkflowExecutionUpdate',
            (rpcOptions) => this.workflowService.pollWorkflowExecutionUpdate(request, rpcOptions),
            mergedCallOptions,
          )
          const stage = this.#stageFromProto(response.stage)
          const runId = response.updateRef?.workflowExecution?.runId || resolvedHandle.runId
          const updateHandle = this.#createWorkflowUpdateHandle(resolvedHandle, {
            updateId,
            runId,
            firstExecutionRunId: pollHandle.firstExecutionRunId,
          })
          const outcome = await decodeUpdateOutcome(this.dataConverter, response.outcome)
          return {
            handle: updateHandle,
            stage,
            outcome,
          }
        } catch (error) {
          throwIfAborted()
          throw error
        } finally {
          this.#abortedUpdates.delete(updateKey)
          this.#releaseUpdateController(updateKey, controller)
          cleanup?.()
        }
      },
      { workflowId: resolvedHandle.workflowId, runId: resolvedHandle.runId, updateId },
    )
  }

  getWorkflowUpdateHandle(
    handle: WorkflowHandle,
    updateId: string,
    firstExecutionRunId?: string,
  ): WorkflowUpdateHandle {
    const resolvedHandle = resolveHandle(this.namespace, handle)
    const normalizedUpdateId = ensureNonEmptyString(updateId, 'updateId')
    const normalizedFirstExecution = ensureOptionalTrimmedString(firstExecutionRunId, 'firstExecutionRunId', 1)
    return this.#createWorkflowUpdateHandle(resolvedHandle, {
      updateId: normalizedUpdateId,
      firstExecutionRunId: normalizedFirstExecution,
    })
  }

  async cancelWorkflowUpdate(handle: WorkflowUpdateHandle): Promise<void> {
    return this.#instrumentOperation(
      'workflow.update',
      async () => {
        this.ensureOpen()
        const resolvedHandle = resolveHandle(this.namespace, handle)
        const updateId = ensureNonEmptyString(handle.updateId, 'updateId')
        const updateKey = this.#makeUpdateKey(resolvedHandle, updateId)
        const aborted = this.#abortUpdateControllers(updateKey)
        if (!aborted) {
          this.#log('debug', 'no pending workflow update operation to cancel', {
            workflowId: resolvedHandle.workflowId,
            updateId,
          })
        }
      },
      { workflowId: handle.workflowId, runId: handle.runId, updateId: handle.updateId },
    )
  }

  async createSchedule(
    request: Omit<CreateScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CreateScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.create',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const requestId = ensureRequestId(request.requestId)
        const payload = create(CreateScheduleRequestSchema, { ...request, namespace, scheduleId, requestId })
        return await this.executeRpc(
          'createSchedule',
          (rpcOptions) => this.workflowService.createSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async describeSchedule(
    request: Omit<DescribeScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.describe',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const payload = create(DescribeScheduleRequestSchema, { ...request, namespace, scheduleId })
        return await this.executeRpc(
          'describeSchedule',
          (rpcOptions) => this.workflowService.describeSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateSchedule(
    request: Omit<UpdateScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.update',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const requestId = ensureRequestId(request.requestId)
        const payload = create(UpdateScheduleRequestSchema, { ...request, namespace, scheduleId, requestId })
        return await this.executeRpc(
          'updateSchedule',
          (rpcOptions) => this.workflowService.updateSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async patchSchedule(
    request: Omit<PatchScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.patch',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const requestId = ensureRequestId(request.requestId)
        const payload = create(PatchScheduleRequestSchema, { ...request, namespace, scheduleId, requestId })
        return await this.executeRpc(
          'patchSchedule',
          (rpcOptions) => this.workflowService.patchSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async listSchedules(
    request: (Omit<ListSchedulesRequest, 'namespace'> & { namespace?: string }) | undefined,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListSchedulesResponse> {
    return this.#instrumentOperation(
      'schedule.list',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request?.namespace ?? this.namespace, 'namespace')
        const payload = create(ListSchedulesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'listSchedules',
          (rpcOptions) => this.workflowService.listSchedules(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request?.namespace ?? this.namespace },
    )
  }

  async listScheduleMatchingTimes(
    request: Omit<ListScheduleMatchingTimesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListScheduleMatchingTimesResponse> {
    return this.#instrumentOperation(
      'schedule.listMatchingTimes',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const payload = create(ListScheduleMatchingTimesRequestSchema, { ...request, namespace, scheduleId })
        return await this.executeRpc(
          'listScheduleMatchingTimes',
          (rpcOptions) => this.workflowService.listScheduleMatchingTimes(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async deleteSchedule(
    request: Omit<DeleteScheduleRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.delete',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const payload = create(DeleteScheduleRequestSchema, { ...request, namespace, scheduleId })
        return await this.executeRpc(
          'deleteSchedule',
          (rpcOptions) => this.workflowService.deleteSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async triggerSchedule(
    request: TriggerScheduleInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.trigger',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const trigger = create(TriggerImmediatelyRequestSchema, request.trigger ?? {})
        const patch = create(SchedulePatchSchema, { triggerImmediately: trigger })
        const requestId = ensureRequestId(request.requestId)
        const payload = create(PatchScheduleRequestSchema, {
          namespace,
          scheduleId,
          patch,
          identity: request.identity,
          requestId,
        })
        return await this.executeRpc(
          'triggerSchedule',
          (rpcOptions) => this.workflowService.patchSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async backfillSchedule(
    request: BackfillScheduleInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.backfill',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const backfillRequest = request.backfillRequest.map((entry) => create(BackfillRequestSchema, entry))
        const patch = create(SchedulePatchSchema, { backfillRequest })
        const requestId = ensureRequestId(request.requestId)
        const payload = create(PatchScheduleRequestSchema, {
          namespace,
          scheduleId,
          patch,
          identity: request.identity,
          requestId,
        })
        return await this.executeRpc(
          'backfillSchedule',
          (rpcOptions) => this.workflowService.patchSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async pauseSchedule(
    request: PauseScheduleInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.pause',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const patch = create(SchedulePatchSchema, { pause: request.reason ?? 'paused' })
        const requestId = ensureRequestId(request.requestId)
        const payload = create(PatchScheduleRequestSchema, {
          namespace,
          scheduleId,
          patch,
          identity: request.identity,
          requestId,
        })
        return await this.executeRpc(
          'pauseSchedule',
          (rpcOptions) => this.workflowService.patchSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async unpauseSchedule(
    request: UnpauseScheduleInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PatchScheduleResponse> {
    return this.#instrumentOperation(
      'schedule.unpause',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const scheduleId = ensureNonEmptyString(request.scheduleId, 'scheduleId')
        const patch = create(SchedulePatchSchema, { unpause: request.reason ?? 'unpaused' })
        const requestId = ensureRequestId(request.requestId)
        const payload = create(PatchScheduleRequestSchema, {
          namespace,
          scheduleId,
          patch,
          identity: request.identity,
          requestId,
        })
        return await this.executeRpc(
          'unpauseSchedule',
          (rpcOptions) => this.workflowService.patchSchedule(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateWorkflowExecutionOptions(
    request: Omit<UpdateWorkflowExecutionOptionsRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkflowExecutionOptionsResponse> {
    return this.#instrumentOperation(
      'workflow.updateOptions',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UpdateWorkflowExecutionOptionsRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'updateWorkflowExecutionOptions',
          (rpcOptions) => this.workflowService.updateWorkflowExecutionOptions(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async pauseWorkflowExecution(
    request: Omit<PauseWorkflowExecutionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<PauseWorkflowExecutionResponse> {
    return this.#instrumentOperation(
      'workflow.pause',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(PauseWorkflowExecutionRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'pauseWorkflowExecution',
          (rpcOptions) => this.workflowService.pauseWorkflowExecution(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async unpauseWorkflowExecution(
    request: Omit<UnpauseWorkflowExecutionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UnpauseWorkflowExecutionResponse> {
    return this.#instrumentOperation(
      'workflow.unpause',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UnpauseWorkflowExecutionRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'unpauseWorkflowExecution',
          (rpcOptions) => this.workflowService.unpauseWorkflowExecution(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async resetStickyTaskQueue(
    request: Omit<ResetStickyTaskQueueRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ResetStickyTaskQueueResponse> {
    return this.#instrumentOperation(
      'workflow.resetStickyTaskQueue',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(ResetStickyTaskQueueRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'resetStickyTaskQueue',
          (rpcOptions) => this.workflowService.resetStickyTaskQueue(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async listWorkers(
    request: (Omit<ListWorkersRequest, 'namespace'> & { namespace?: string }) | undefined,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListWorkersResponse> {
    return this.#instrumentOperation(
      'worker.list',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request?.namespace ?? this.namespace, 'namespace')
        const payload = create(ListWorkersRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'listWorkers',
          (rpcOptions) => this.workflowService.listWorkers(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request?.namespace ?? this.namespace },
    )
  }

  async describeWorker(
    request: Omit<DescribeWorkerRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeWorkerResponse> {
    return this.#instrumentOperation(
      'worker.describe',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(DescribeWorkerRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'describeWorker',
          (rpcOptions) => this.workflowService.describeWorker(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async fetchWorkerConfig(
    request: Omit<FetchWorkerConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<FetchWorkerConfigResponse> {
    return this.#instrumentOperation(
      'worker.fetchConfig',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(FetchWorkerConfigRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'fetchWorkerConfig',
          (rpcOptions) => this.workflowService.fetchWorkerConfig(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateWorkerConfig(
    request: Omit<UpdateWorkerConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerConfigResponse> {
    return this.#instrumentOperation(
      'worker.updateConfig',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UpdateWorkerConfigRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'updateWorkerConfig',
          (rpcOptions) => this.workflowService.updateWorkerConfig(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateTaskQueueConfig(
    request: Omit<UpdateTaskQueueConfigRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateTaskQueueConfigResponse> {
    return this.#instrumentOperation(
      'worker.updateTaskQueueConfig',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UpdateTaskQueueConfigRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'updateTaskQueueConfig',
          (rpcOptions) => this.workflowService.updateTaskQueueConfig(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async getWorkerVersioningRules(
    request: Omit<GetWorkerVersioningRulesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetWorkerVersioningRulesResponse> {
    return this.#instrumentOperation(
      'worker.getVersioningRules',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(GetWorkerVersioningRulesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'getWorkerVersioningRules',
          (rpcOptions) => this.workflowService.getWorkerVersioningRules(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateWorkerVersioningRules(
    request: Omit<UpdateWorkerVersioningRulesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerVersioningRulesResponse> {
    return this.#instrumentOperation(
      'worker.updateVersioningRules',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UpdateWorkerVersioningRulesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'updateWorkerVersioningRules',
          (rpcOptions) => this.workflowService.updateWorkerVersioningRules(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async listWorkerDeployments(
    request: (Omit<ListWorkerDeploymentsRequest, 'namespace'> & { namespace?: string }) | undefined,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListWorkerDeploymentsResponse> {
    return this.#instrumentOperation(
      'deployment.listWorkerDeployments',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request?.namespace ?? this.namespace, 'namespace')
        const payload = create(ListWorkerDeploymentsRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'listWorkerDeployments',
          (rpcOptions) => this.workflowService.listWorkerDeployments(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request?.namespace ?? this.namespace },
    )
  }

  async describeWorkerDeployment(
    request: DescribeWorkerDeploymentInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeWorkerDeploymentResponse> {
    return this.#instrumentOperation(
      'deployment.describeWorkerDeployment',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(DescribeWorkerDeploymentRequestSchema, {
          namespace,
          deploymentName: request.deploymentName,
        })
        return await this.executeRpc(
          'describeWorkerDeployment',
          (rpcOptions) => this.workflowService.describeWorkerDeployment(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async listDeployments(
    request: (Omit<ListDeploymentsRequest, 'namespace'> & { namespace?: string }) | undefined,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListDeploymentsResponse> {
    return this.#instrumentOperation(
      'deployment.list',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request?.namespace ?? this.namespace, 'namespace')
        const payload = create(ListDeploymentsRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'listDeployments',
          (rpcOptions) => this.workflowService.listDeployments(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request?.namespace ?? this.namespace },
    )
  }

  async describeDeployment(
    request: Omit<DescribeDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DescribeDeploymentResponse> {
    return this.#instrumentOperation(
      'deployment.describe',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(DescribeDeploymentRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'describeDeployment',
          (rpcOptions) => this.workflowService.describeDeployment(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async getCurrentDeployment(
    request: Omit<GetCurrentDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetCurrentDeploymentResponse> {
    return this.#instrumentOperation(
      'deployment.getCurrent',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(GetCurrentDeploymentRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'getCurrentDeployment',
          (rpcOptions) => this.workflowService.getCurrentDeployment(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async setCurrentDeployment(
    request: Omit<SetCurrentDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetCurrentDeploymentResponse> {
    return this.#instrumentOperation(
      'deployment.setCurrent',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(SetCurrentDeploymentRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'setCurrentDeployment',
          (rpcOptions) => this.workflowService.setCurrentDeployment(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async getDeploymentReachability(
    request: Omit<GetDeploymentReachabilityRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetDeploymentReachabilityResponse> {
    return this.#instrumentOperation(
      'deployment.reachability',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(GetDeploymentReachabilityRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'getDeploymentReachability',
          (rpcOptions) => this.workflowService.getDeploymentReachability(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async setWorkerDeploymentCurrentVersion(
    request: SetWorkerDeploymentCurrentVersionInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentCurrentVersionResponse> {
    return this.#instrumentOperation(
      'deployment.setCurrentVersion',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(SetWorkerDeploymentCurrentVersionRequestSchema, {
          namespace,
          deploymentName: request.deploymentName,
          buildId: request.buildId,
          version: request.version ?? '',
          conflictToken: request.conflictToken ?? new Uint8Array(),
          identity: request.identity ?? '',
          ignoreMissingTaskQueues: request.ignoreMissingTaskQueues ?? false,
          allowNoPollers: request.allowNoPollers ?? false,
        })
        return await this.executeRpc(
          'setWorkerDeploymentCurrentVersion',
          (rpcOptions) => this.workflowService.setWorkerDeploymentCurrentVersion(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async setWorkerDeploymentRampingVersion(
    request: SetWorkerDeploymentRampingVersionInput,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentRampingVersionResponse> {
    return this.#instrumentOperation(
      'deployment.setRampingVersion',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(SetWorkerDeploymentRampingVersionRequestSchema, {
          namespace,
          deploymentName: request.deploymentName,
          buildId: request.buildId,
          percentage: request.percentage,
          version: request.version ?? '',
          conflictToken: request.conflictToken ?? new Uint8Array(),
          identity: request.identity ?? '',
          ignoreMissingTaskQueues: request.ignoreMissingTaskQueues ?? false,
          allowNoPollers: request.allowNoPollers ?? false,
        })
        return await this.executeRpc(
          'setWorkerDeploymentRampingVersion',
          (rpcOptions) => this.workflowService.setWorkerDeploymentRampingVersion(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async updateWorkerDeploymentVersionMetadata(
    request: Omit<UpdateWorkerDeploymentVersionMetadataRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateWorkerDeploymentVersionMetadataResponse> {
    return this.#instrumentOperation(
      'deployment.updateVersionMetadata',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(UpdateWorkerDeploymentVersionMetadataRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'updateWorkerDeploymentVersionMetadata',
          (rpcOptions) => this.workflowService.updateWorkerDeploymentVersionMetadata(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async deleteWorkerDeploymentVersion(
    request: Omit<DeleteWorkerDeploymentVersionRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteWorkerDeploymentVersionResponse> {
    return this.#instrumentOperation(
      'deployment.deleteVersion',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(DeleteWorkerDeploymentVersionRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'deleteWorkerDeploymentVersion',
          (rpcOptions) => this.workflowService.deleteWorkerDeploymentVersion(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async deleteWorkerDeployment(
    request: Omit<DeleteWorkerDeploymentRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteWorkerDeploymentResponse> {
    return this.#instrumentOperation(
      'deployment.delete',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(DeleteWorkerDeploymentRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'deleteWorkerDeployment',
          (rpcOptions) => this.workflowService.deleteWorkerDeployment(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async setWorkerDeploymentManager(
    request: Omit<SetWorkerDeploymentManagerRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<SetWorkerDeploymentManagerResponse> {
    return this.#instrumentOperation(
      'deployment.setManager',
      async () => {
        this.ensureOpen()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(SetWorkerDeploymentManagerRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'setWorkerDeploymentManager',
          (rpcOptions) => this.workflowService.setWorkerDeploymentManager(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async addSearchAttributes(
    request: Omit<AddSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<AddSearchAttributesResponse> {
    return this.#instrumentOperation(
      'operator.addSearchAttributes',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(AddSearchAttributesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'addSearchAttributes',
          (rpcOptions) => operator.addSearchAttributes(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async removeSearchAttributes(
    request: Omit<RemoveSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<RemoveSearchAttributesResponse> {
    return this.#instrumentOperation(
      'operator.removeSearchAttributes',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(RemoveSearchAttributesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'removeSearchAttributes',
          (rpcOptions) => operator.removeSearchAttributes(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async listSearchAttributes(
    request: Omit<ListSearchAttributesRequest, 'namespace'> & { namespace?: string },
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListSearchAttributesResponse> {
    return this.#instrumentOperation(
      'operator.listSearchAttributes',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const namespace = ensureNonEmptyString(request.namespace ?? this.namespace, 'namespace')
        const payload = create(ListSearchAttributesRequestSchema, { ...request, namespace })
        return await this.executeRpc(
          'listSearchAttributes',
          (rpcOptions) => operator.listSearchAttributes(payload, rpcOptions),
          callOptions,
        )
      },
      { namespace: request.namespace ?? this.namespace },
    )
  }

  async createNexusEndpoint(
    request: CreateNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CreateNexusEndpointResponse> {
    return this.#instrumentOperation(
      'operator.createNexusEndpoint',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const payload = create(CreateNexusEndpointRequestSchema, request)
        return await this.executeRpc(
          'createNexusEndpoint',
          (rpcOptions) => operator.createNexusEndpoint(payload, rpcOptions),
          callOptions,
        )
      },
      {},
    )
  }

  async updateNexusEndpoint(
    request: UpdateNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<UpdateNexusEndpointResponse> {
    return this.#instrumentOperation(
      'operator.updateNexusEndpoint',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const payload = create(UpdateNexusEndpointRequestSchema, request)
        return await this.executeRpc(
          'updateNexusEndpoint',
          (rpcOptions) => operator.updateNexusEndpoint(payload, rpcOptions),
          callOptions,
        )
      },
      {},
    )
  }

  async deleteNexusEndpoint(
    request: DeleteNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<DeleteNexusEndpointResponse> {
    return this.#instrumentOperation(
      'operator.deleteNexusEndpoint',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const payload = create(DeleteNexusEndpointRequestSchema, request)
        return await this.executeRpc(
          'deleteNexusEndpoint',
          (rpcOptions) => operator.deleteNexusEndpoint(payload, rpcOptions),
          callOptions,
        )
      },
      {},
    )
  }

  async getNexusEndpoint(
    request: GetNexusEndpointRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<GetNexusEndpointResponse> {
    return this.#instrumentOperation(
      'operator.getNexusEndpoint',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const payload = create(GetNexusEndpointRequestSchema, request)
        return await this.executeRpc(
          'getNexusEndpoint',
          (rpcOptions) => operator.getNexusEndpoint(payload, rpcOptions),
          callOptions,
        )
      },
      {},
    )
  }

  async listNexusEndpoints(
    request?: ListNexusEndpointsRequest,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<ListNexusEndpointsResponse> {
    return this.#instrumentOperation(
      'operator.listNexusEndpoints',
      async () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const payload = create(ListNexusEndpointsRequestSchema, request ?? {})
        return await this.executeRpc(
          'listNexusEndpoints',
          (rpcOptions) => operator.listNexusEndpoints(payload, rpcOptions),
          callOptions,
        )
      },
      {},
    )
  }

  callWorkflowService<T extends WorkflowServiceMethodName>(
    method: T,
    request: WorkflowServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<WorkflowServiceResponse<T>> {
    return this.#instrumentOperation<WorkflowServiceResponse<T>>(
      'rpc',
      () => {
        this.ensureOpen()
        const rpc = this.workflowService[method] as (
          input: WorkflowServiceRequest<T>,
          options: CallOptions,
        ) => ReturnType<WorkflowServiceClient[T]>
        return this.executeRpc<WorkflowServiceResponse<T>>(
          `workflowService.${String(method)}`,
          (rpcOptions) => rpc(request, rpcOptions) as Promise<WorkflowServiceResponse<T>>,
          callOptions,
        )
      },
      { workflowServiceMethod: String(method) },
    )
  }

  callOperatorService<T extends OperatorServiceMethodName>(
    method: T,
    request: OperatorServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<OperatorServiceResponse<T>> {
    return this.#instrumentOperation<OperatorServiceResponse<T>>(
      'rpc',
      () => {
        this.ensureOpen()
        const operator = this.#requireOperatorService()
        const rpc = operator[method] as (
          input: OperatorServiceRequest<T>,
          options: CallOptions,
        ) => ReturnType<OperatorServiceClient[T]>
        return this.executeRpc<OperatorServiceResponse<T>>(
          `operatorService.${String(method)}`,
          (rpcOptions) => rpc(request, rpcOptions) as Promise<OperatorServiceResponse<T>>,
          callOptions,
        )
      },
      { operatorServiceMethod: String(method) },
    )
  }

  callCloudService<T extends CloudServiceMethodName>(
    method: T,
    request: CloudServiceRequest<T>,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<CloudServiceResponse<T>> {
    return this.#instrumentOperation<CloudServiceResponse<T>>(
      'rpc',
      () => {
        this.ensureOpen()
        const cloud = this.#requireCloudService()
        const rpc = cloud[method] as (
          input: CloudServiceRequest<T>,
          options: CallOptions,
        ) => ReturnType<CloudServiceClient[T]>
        return this.executeCloudRpc<CloudServiceResponse<T>>(
          `cloud.${String(method)}`,
          (rpcOptions) => rpc(request, rpcOptions) as Promise<CloudServiceResponse<T>>,
          callOptions,
        )
      },
      { cloudMethod: String(method) },
    )
  }

  async describeNamespace(
    targetNamespace?: string,
    callOptions?: BrandedTemporalClientCallOptions,
  ): Promise<Uint8Array> {
    return this.#instrumentOperation(
      'workflow.describe',
      async () => {
        this.ensureOpen()
        const request: DescribeNamespaceRequest = create(DescribeNamespaceRequestSchema, {
          namespace: targetNamespace ?? this.namespace,
        })

        const response = await this.executeRpc(
          'describeNamespace',
          (rpcOptions) => this.workflowService.describeNamespace(request, rpcOptions),
          callOptions,
        )
        return toBinary(DescribeNamespaceResponseSchema, response)
      },
      { namespace: targetNamespace ?? this.namespace },
    )
  }

  async updateHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void> {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }
    const normalized = normalizeMetadataHeaders(headers)
    this.headers = mergeHeaders(this.headers, normalized)
  }

  async updateCloudHeaders(headers: Record<string, string | ArrayBuffer | ArrayBufferView>): Promise<void> {
    if (this.closed) {
      throw new Error('Temporal client has already been shut down')
    }
    const normalized = normalizeMetadataHeaders(headers)
    this.cloudHeaders = mergeHeaders(this.cloudHeaders, normalized)
  }

  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true

    if (this.transport) {
      const maybeClose = this.transport.close
      if (typeof maybeClose === 'function') {
        await maybeClose.call(this.transport)
      }
    }
    if (this.cloudTransport) {
      const maybeClose = this.cloudTransport.close
      if (typeof maybeClose === 'function') {
        await maybeClose.call(this.cloudTransport)
      }
    }
    await this.#flushMetrics()
  }

  async #flushMetrics(): Promise<void> {
    try {
      await Effect.runPromise(this.#metricsExporter.flush())
    } catch (error) {
      this.#log('warn', 'failed to flush client metrics exporter', {
        error: describeError(error),
      })
    }
  }

  #recordMetrics(durationMs: number, failed: boolean): void {
    void Effect.runPromise(this.#clientMetrics.operationCount.inc())
    void Effect.runPromise(this.#clientMetrics.operationLatency.observe(durationMs))
    if (failed) {
      void Effect.runPromise(this.#clientMetrics.operationErrors.inc())
    }
  }

  async #instrumentOperation<T>(
    operation: InterceptorKind,
    action: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const context = {
      kind: operation,
      namespace: this.namespace,
      taskQueue: (metadata.taskQueue as string | undefined) ?? this.defaultTaskQueue,
      identity: this.defaultIdentity,
      workflowId: metadata.workflowId as string | undefined,
      runId: metadata.runId as string | undefined,
      updateId: metadata.updateId as string | undefined,
      metadata,
    }
    const start = Date.now()
    const effect = runClientInterceptors<T>(this.#clientInterceptors, context, () => Effect.tryPromise(action))
    try {
      const result = await Effect.runPromise(effect)
      this.#log('debug', `temporal client ${operation} succeeded`, {
        operation,
        namespace: this.namespace,
        ...metadata,
      })
      this.#recordMetrics(Date.now() - start, false)
      return result
    } catch (error) {
      const normalized = normalizeUnknownError(error)
      const finalError =
        normalized instanceof Error &&
        normalized.message.toLowerCase().includes('unknown error occurred in effect.trypromise')
          ? ((normalized as { cause?: unknown; error?: unknown }).cause ??
            (normalized as { cause?: unknown; error?: unknown }).error ??
            normalized)
          : normalized
      const message = finalError instanceof Error ? finalError.message.toLowerCase() : ''
      const isUnknownPollAbort =
        operation === 'workflow.awaitUpdate' && message.includes('unknown error occurred in effect.trypromise')
      if (isAbortLikeError(normalized)) {
        this.#log('warn', `temporal client ${operation} aborted`, {
          operation,
          error: describeError(normalized),
          ...metadata,
        })
        this.#recordMetrics(Date.now() - start, true)
        throw finalError
      }
      if (isUnknownPollAbort) {
        const abortError = new Error('Workflow update polling aborted')
        abortError.name = 'AbortError'
        this.#log('warn', `temporal client ${operation} aborted`, {
          operation,
          error: describeError(abortError),
          ...metadata,
        })
        this.#recordMetrics(Date.now() - start, true)
        throw abortError
      }
      this.#log('error', `temporal client ${operation} failed`, {
        operation,
        error: describeError(finalError),
        ...metadata,
      })
      this.#recordMetrics(Date.now() - start, true)
      throw finalError
    }
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    void Effect.runPromise(
      this.#logger.log(level, message, fields).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.warn(`[temporal-bun-sdk] client logger failure: ${describeError(error)}`)
          }),
        ),
      ),
    )
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Temporal client has been shut down')
    }
  }

  #splitArgsAndOptions(args: unknown[]): { values: unknown[]; callOptions?: BrandedTemporalClientCallOptions } {
    if (!args.length) {
      return { values: [] }
    }
    const last = args[args.length - 1]
    if (isCallOptionsCandidate(last)) {
      return {
        values: args.slice(0, -1),
        callOptions: last,
      }
    }
    return { values: args }
  }

  #prepareUpdateCallOptions(
    key: string,
    callOptions?: BrandedTemporalClientCallOptions,
  ): { options: TemporalClientCallOptions; controller: AbortController; cleanup?: () => void } {
    const controller = new AbortController()
    let cleanup: (() => void) | undefined
    if (callOptions?.signal) {
      if (callOptions.signal.aborted) {
        controller.abort()
      } else {
        const onAbort = () => controller.abort()
        callOptions.signal.addEventListener('abort', onAbort, { once: true })
        cleanup = () => callOptions.signal?.removeEventListener('abort', onAbort)
      }
    }
    this.#registerUpdateController(key, controller)
    const overrides: TemporalClientCallOptions = {
      ...(callOptions ? { ...callOptions } : {}),
      signal: controller.signal,
    }
    return { options: overrides, controller, cleanup }
  }

  #registerUpdateController(key: string, controller: AbortController): void {
    this.#abortedUpdates.delete(key)
    const current = this.#pendingUpdateControllers.get(key)
    if (current) {
      current.add(controller)
      return
    }
    this.#pendingUpdateControllers.set(key, new Set([controller]))
  }

  #releaseUpdateController(key: string, controller: AbortController): void {
    const current = this.#pendingUpdateControllers.get(key)
    if (!current) {
      return
    }
    current.delete(controller)
    if (current.size === 0) {
      this.#pendingUpdateControllers.delete(key)
    }
  }

  #abortUpdateControllers(key: string): boolean {
    const current = this.#pendingUpdateControllers.get(key)
    if (!current || current.size === 0) {
      this.#abortedUpdates.add(key)
      return false
    }
    for (const controller of current) {
      controller.abort()
    }
    this.#pendingUpdateControllers.delete(key)
    this.#abortedUpdates.add(key)
    return true
  }

  #makeUpdateKey(handle: WorkflowHandle, updateId: string): string {
    const namespace = handle.namespace ?? this.namespace
    const runId = handle.runId ?? ''
    return `${namespace}::${handle.workflowId}::${runId}::${updateId}`
  }

  #createWorkflowUpdateHandle(
    handle: WorkflowHandle,
    overrides: { updateId: string; runId?: string | null; firstExecutionRunId?: string | null },
  ): WorkflowUpdateHandle {
    return {
      workflowId: handle.workflowId,
      namespace: handle.namespace,
      runId: overrides.runId ?? handle.runId,
      firstExecutionRunId: overrides.firstExecutionRunId ?? handle.firstExecutionRunId,
      updateId: overrides.updateId,
    }
  }

  #stageToProto(
    stage: WorkflowUpdateStage | undefined,
    minimum: UpdateWorkflowExecutionLifecycleStage = UpdateWorkflowExecutionLifecycleStage.ADMITTED,
  ): UpdateWorkflowExecutionLifecycleStage {
    const normalized = ensureWorkflowUpdateStage(stage)
    const protoStage = WORKFLOW_UPDATE_STAGE_TO_PROTO[normalized]
    return protoStage >= minimum ? protoStage : minimum
  }

  #stageFromProto(stage?: UpdateWorkflowExecutionLifecycleStage): WorkflowUpdateStage {
    if (stage === UpdateWorkflowExecutionLifecycleStage.ADMITTED) {
      return 'admitted'
    }
    if (stage === UpdateWorkflowExecutionLifecycleStage.ACCEPTED) {
      return 'accepted'
    }
    if (stage === UpdateWorkflowExecutionLifecycleStage.COMPLETED) {
      return 'completed'
    }
    return 'unspecified'
  }

  #mergeRetryPolicy(overrides?: Partial<TemporalRpcRetryPolicy>): TemporalRpcRetryPolicy {
    const base = this.config.rpcRetryPolicy
    if (!overrides) {
      return {
        ...base,
        retryableStatusCodes: [...base.retryableStatusCodes],
      }
    }
    const maxAttempts = overrides.maxAttempts ?? base.maxAttempts
    const initialDelayMs = overrides.initialDelayMs ?? base.initialDelayMs
    const maxDelayMs = overrides.maxDelayMs ?? base.maxDelayMs
    const backoffCoefficient = overrides.backoffCoefficient ?? base.backoffCoefficient
    const jitterFactor = overrides.jitterFactor ?? base.jitterFactor
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error('retryPolicy.maxAttempts must be a positive integer')
    }
    if (!Number.isInteger(initialDelayMs) || initialDelayMs <= 0) {
      throw new Error('retryPolicy.initialDelayMs must be a positive integer')
    }
    if (!Number.isInteger(maxDelayMs) || maxDelayMs <= 0) {
      throw new Error('retryPolicy.maxDelayMs must be a positive integer')
    }
    if (maxDelayMs < initialDelayMs) {
      throw new Error('retryPolicy.maxDelayMs must be greater than or equal to retryPolicy.initialDelayMs')
    }
    if (typeof backoffCoefficient !== 'number' || !Number.isFinite(backoffCoefficient) || backoffCoefficient <= 0) {
      throw new Error('retryPolicy.backoffCoefficient must be a positive number')
    }
    if (typeof jitterFactor !== 'number' || jitterFactor < 0 || jitterFactor > 1) {
      throw new Error('retryPolicy.jitterFactor must be between 0 and 1')
    }
    const retryableStatusCodes = overrides.retryableStatusCodes
      ? [...overrides.retryableStatusCodes]
      : [...base.retryableStatusCodes]
    return {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      backoffCoefficient,
      jitterFactor,
      retryableStatusCodes,
    }
  }

  #extractCloseEvent(response: GetWorkflowExecutionHistoryResponse | null | undefined): HistoryEvent | undefined {
    const events = response?.history?.events ?? []
    if (events.length === 0) {
      return undefined
    }
    return events[events.length - 1]
  }

  #buildCallContext(
    overrides?: TemporalClientCallOptions,
    baseHeaders?: Record<string, string>,
  ): {
    create: () => CallOptions
    retryPolicy: TemporalRpcRetryPolicy
    headers: Record<string, string>
  } {
    const base = baseHeaders ?? this.headers
    const userHeaders = overrides?.headers ? normalizeMetadataHeaders(overrides.headers) : undefined
    const mergedHeaders = userHeaders ? mergeHeaders(base, userHeaders) : { ...base }
    const timeout = overrides?.timeoutMs
    const signal = overrides?.signal
    return {
      create: () => ({
        headers: { ...mergedHeaders },
        timeoutMs: timeout,
        signal,
      }),
      retryPolicy: this.#mergeRetryPolicy(overrides?.retryPolicy),
      headers: mergedHeaders,
    }
  }

  #requireOperatorService(): OperatorServiceClient {
    if (!this.operatorService) {
      throw new Error('Temporal operator service is not available')
    }
    return this.operatorService
  }

  #requireCloudService(): CloudServiceClient {
    if (!this.cloudService) {
      throw new Error('Temporal cloud service is not available')
    }
    return this.cloudService
  }

  private async executeRpc<T>(
    operation: string,
    rpc: (options: CallOptions) => Promise<T>,
    overrides?: TemporalClientCallOptions,
  ): Promise<T> {
    const { create, retryPolicy, headers } = this.#buildCallContext(overrides)
    const interceptorContext: Omit<InterceptorContext, 'direction'> = {
      kind: 'rpc' as InterceptorKind,
      namespace: this.namespace,
      taskQueue: this.defaultTaskQueue,
      identity: this.defaultIdentity,
      headers,
      metadata: { retryPolicy },
    }

    const baseEffect = () =>
      Effect.tryPromise({
        try: () => {
          interceptorContext.attempt = (interceptorContext.attempt ?? 0) + 1
          return rpc(create())
        },
        catch: (error) => wrapRpcError(error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            this.#log('warn', `temporal rpc ${operation} attempt failed`, {
              operation,
              attempt: interceptorContext.attempt,
              error: describeError(error),
            })
          }),
        ),
      )

    const result = await Effect.runPromise(
      runClientInterceptors<T>(this.#clientInterceptors, interceptorContext, baseEffect),
    )
    if ((interceptorContext.attempt ?? 1) > 1) {
      this.#log('info', `temporal rpc ${operation} succeeded after ${interceptorContext.attempt} attempts`, {
        operation,
        attempts: interceptorContext.attempt,
      })
    }
    return result
  }

  private async executeCloudRpc<T>(
    operation: string,
    rpc: (options: CallOptions) => Promise<T>,
    overrides?: TemporalClientCallOptions,
  ): Promise<T> {
    const { create, retryPolicy, headers } = this.#buildCallContext(overrides, this.cloudHeaders)
    const interceptorContext: Omit<InterceptorContext, 'direction'> = {
      kind: 'rpc' as InterceptorKind,
      namespace: this.namespace,
      taskQueue: this.defaultTaskQueue,
      identity: this.defaultIdentity,
      headers,
      metadata: { retryPolicy },
    }

    const baseEffect = () =>
      Effect.tryPromise({
        try: () => {
          interceptorContext.attempt = (interceptorContext.attempt ?? 0) + 1
          return rpc(create())
        },
        catch: (error) => wrapRpcError(error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            this.#log('warn', `temporal cloud rpc ${operation} attempt failed`, {
              operation,
              attempt: interceptorContext.attempt,
              error: describeError(error),
            })
          }),
        ),
      )

    const result = await Effect.runPromise(
      runClientInterceptors<T>(this.#clientInterceptors, interceptorContext, baseEffect),
    )
    if ((interceptorContext.attempt ?? 1) > 1) {
      this.#log('info', `temporal cloud rpc ${operation} succeeded after ${interceptorContext.attempt} attempts`, {
        operation,
        attempts: interceptorContext.attempt,
      })
    }
    return result
  }

  private toStartWorkflowResult(
    response: StartWorkflowExecutionResponse | SignalWithStartWorkflowExecutionResponse,
    metadata: {
      workflowId: string
      namespace: string
      firstExecutionRunId?: string
    },
  ): StartWorkflowResult {
    const runId = ensureNonEmptyString(response.runId, 'runId')
    const workflowId = ensureNonEmptyString(metadata.workflowId, 'workflowId')
    const namespace = ensureNonEmptyString(metadata.namespace, 'namespace')
    const firstExecutionRunId = metadata.firstExecutionRunId
      ? ensureNonEmptyString(metadata.firstExecutionRunId, 'firstExecutionRunId')
      : undefined

    const parsed: WorkflowHandleMetadata = {
      runId,
      workflowId,
      namespace,
      firstExecutionRunId,
    }

    return {
      ...parsed,
      handle: createWorkflowHandle(parsed),
    }
  }

  private async parseQueryResult(response: QueryWorkflowResponse): Promise<unknown> {
    if (response.queryRejected) {
      throw new ConnectError('Temporal query was rejected', Code.FailedPrecondition, undefined, undefined, {
        message: response.queryRejected.status.toString(),
      })
    }

    const payloads = response.queryResult?.payloads ?? []
    if (!payloads.length) {
      return null
    }

    const [value] = await decodePayloadsToValues(this.dataConverter, payloads as unknown as Payload[])
    return value ?? null
  }
}

const ensureOptionalTrimmedString = (value: string | undefined, field: string, minLength = 0): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    throw new Error(`${field} must be at least ${minLength} characters`)
  }
  return trimmed
}

const ensureNonEmptyString = (value: string | undefined, field: string): string => {
  const trimmed = ensureOptionalTrimmedString(value, field, 1)
  if (trimmed === undefined) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return trimmed
}

const ensureRequestId = (value?: string): string => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : randomUUID()
}

const ensureOptionalPositiveInteger = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

const ensureOptionalInteger = (
  value: number | undefined,
  field: string,
  minimum = Number.MIN_SAFE_INTEGER,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

const ensureOptionalPositiveNumber = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`)
  }
  return value
}

const sanitizeRetryPolicy = (policy?: RetryPolicyOptions): RetryPolicyOptions | undefined => {
  if (!policy) {
    return undefined
  }

  const sanitized: RetryPolicyOptions = {}

  sanitized.initialIntervalMs = ensureOptionalPositiveInteger(policy.initialIntervalMs, 'retryPolicy.initialIntervalMs')
  sanitized.maximumIntervalMs = ensureOptionalPositiveInteger(policy.maximumIntervalMs, 'retryPolicy.maximumIntervalMs')
  sanitized.maximumAttempts = ensureOptionalInteger(policy.maximumAttempts, 'retryPolicy.maximumAttempts', 0)
  sanitized.backoffCoefficient = ensureOptionalPositiveNumber(
    policy.backoffCoefficient,
    'retryPolicy.backoffCoefficient',
  )

  if (policy.nonRetryableErrorTypes !== undefined) {
    if (!Array.isArray(policy.nonRetryableErrorTypes)) {
      throw new Error('retryPolicy.nonRetryableErrorTypes must be an array when provided')
    }
    sanitized.nonRetryableErrorTypes = policy.nonRetryableErrorTypes.map((type, index) =>
      ensureNonEmptyString(type, `retryPolicy.nonRetryableErrorTypes[${index}]`),
    )
  }

  return sanitized
}

const isVersioningBehavior = (value: number): value is VersioningBehavior =>
  value === VersioningBehavior.UNSPECIFIED ||
  value === VersioningBehavior.PINNED ||
  value === VersioningBehavior.AUTO_UPGRADE

const sanitizeVersioningBehavior = (value: unknown): VersioningBehavior | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !isVersioningBehavior(value)) {
    throw new Error('versioningBehavior must be one of UNSPECIFIED, PINNED, or AUTO_UPGRADE')
  }
  return value
}

const sanitizeStartWorkflowOptions = (options: StartWorkflowOptions): StartWorkflowOptions => {
  const sanitized: StartWorkflowOptions = {
    ...options,
    workflowId: ensureNonEmptyString(options.workflowId, 'workflowId'),
    workflowType: ensureNonEmptyString(options.workflowType, 'workflowType'),
  }

  sanitized.taskQueue = ensureOptionalTrimmedString(options.taskQueue, 'taskQueue', 1)
  sanitized.namespace = ensureOptionalTrimmedString(options.namespace, 'namespace', 1)
  sanitized.identity = ensureOptionalTrimmedString(options.identity, 'identity', 1)
  sanitized.versioningBehavior = sanitizeVersioningBehavior(options.versioningBehavior)
  sanitized.cronSchedule = ensureOptionalTrimmedString(options.cronSchedule, 'cronSchedule', 1)
  sanitized.requestId = ensureOptionalTrimmedString(options.requestId, 'requestId', 1)

  sanitized.workflowExecutionTimeoutMs = ensureOptionalPositiveInteger(
    options.workflowExecutionTimeoutMs,
    'workflowExecutionTimeoutMs',
  )
  sanitized.workflowRunTimeoutMs = ensureOptionalPositiveInteger(options.workflowRunTimeoutMs, 'workflowRunTimeoutMs')
  sanitized.workflowTaskTimeoutMs = ensureOptionalPositiveInteger(
    options.workflowTaskTimeoutMs,
    'workflowTaskTimeoutMs',
  )

  sanitized.retryPolicy = sanitizeRetryPolicy(options.retryPolicy)

  return sanitized
}

const sanitizeTerminateWorkflowOptions = (options: TerminateWorkflowOptions = {}): TerminateWorkflowOptions => {
  if (options.details !== undefined && !Array.isArray(options.details)) {
    throw new Error('details must be an array when provided')
  }

  return {
    ...options,
    reason: options.reason === undefined ? undefined : options.reason.trim(),
    runId: ensureOptionalTrimmedString(options.runId, 'runId', 1),
    firstExecutionRunId: ensureOptionalTrimmedString(options.firstExecutionRunId, 'firstExecutionRunId', 1),
  }
}

type NormalizedWorkflowUpdateOptions = {
  updateName: string
  args: unknown[]
  headers?: Record<string, unknown>
  updateId?: string
  waitForStage: WorkflowUpdateStage
  firstExecutionRunId?: string
}

const sanitizeWorkflowUpdateOptions = (options: WorkflowUpdateOptions): NormalizedWorkflowUpdateOptions => {
  if (!options || typeof options !== 'object') {
    throw new Error('Workflow update options must be provided')
  }
  const updateName = ensureNonEmptyString(options.updateName, 'updateName')
  const args = options.args ?? []
  if (!Array.isArray(args)) {
    throw new Error('update args must be an array when provided')
  }
  const waitForStage = ensureWorkflowUpdateStage(options.waitForStage)
  const updateId = ensureOptionalTrimmedString(options.updateId, 'updateId', 1)
  const firstExecutionRunId = ensureOptionalTrimmedString(options.firstExecutionRunId, 'firstExecutionRunId', 1)
  return {
    updateName,
    args,
    headers: options.headers,
    updateId,
    waitForStage,
    firstExecutionRunId,
  }
}

const WORKFLOW_UPDATE_STAGE_VALUES: ReadonlySet<WorkflowUpdateStage> = new Set([
  'unspecified',
  'admitted',
  'accepted',
  'completed',
])

const DEFAULT_WORKFLOW_UPDATE_STAGE: WorkflowUpdateStage = 'accepted'

const WORKFLOW_UPDATE_STAGE_TO_PROTO: Record<WorkflowUpdateStage, UpdateWorkflowExecutionLifecycleStage> = {
  unspecified: UpdateWorkflowExecutionLifecycleStage.UNSPECIFIED,
  admitted: UpdateWorkflowExecutionLifecycleStage.ADMITTED,
  accepted: UpdateWorkflowExecutionLifecycleStage.ACCEPTED,
  completed: UpdateWorkflowExecutionLifecycleStage.COMPLETED,
}

const ensureWorkflowUpdateStage = (stage?: WorkflowUpdateStage): WorkflowUpdateStage => {
  if (!stage) {
    return DEFAULT_WORKFLOW_UPDATE_STAGE
  }
  if (!WORKFLOW_UPDATE_STAGE_VALUES.has(stage)) {
    throw new Error('waitForStage must be one of unspecified, admitted, accepted, or completed')
  }
  return stage
}

const resolveHandle = (defaultNamespace: string, handle: WorkflowHandle): WorkflowHandle => {
  const workflowId = ensureNonEmptyString(handle.workflowId, 'workflowId')
  const namespace = ensureOptionalTrimmedString(handle.namespace, 'namespace', 1) ?? defaultNamespace
  const runId = ensureOptionalTrimmedString(handle.runId, 'runId', 1)
  const firstExecutionRunId = ensureOptionalTrimmedString(handle.firstExecutionRunId, 'firstExecutionRunId', 1)

  return {
    workflowId,
    namespace,
    runId,
    firstExecutionRunId,
  }
}

export { buildTransportOptions, normalizeTemporalAddress } from './client/transport'

export type {
  SignalWithStartOptions,
  StartWorkflowOptions,
  StartWorkflowResult,
  TerminateWorkflowOptions,
  WorkflowHandle,
  WorkflowUpdateAwaitOptions,
  WorkflowUpdateHandle,
  WorkflowUpdateOptions,
  WorkflowUpdateOutcome,
  WorkflowUpdateResult,
  WorkflowUpdateStage,
} from './client/types'
