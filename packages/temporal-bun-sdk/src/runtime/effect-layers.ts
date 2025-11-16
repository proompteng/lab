import { createClient, type Transport } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Context, Effect, Layer } from 'effect'

import {
  type InterceptorBuilder,
  makeDefaultInterceptorBuilder,
  type TemporalInterceptor,
} from '../client/interceptors'
import { buildTransportOptions, normalizeTemporalAddress } from '../client/transport'
import type { TemporalConfig, TemporalConfigError, TemporalTlsConfigurationError } from '../config'
import { createObservabilityServices, type ObservabilityOverrides, type ObservabilityServices } from '../observability'
import type { Logger } from '../observability/logger'
import type { MetricsExporter, MetricsRegistry } from '../observability/metrics'
import { WorkflowService } from '../proto/temporal/api/workflowservice/v1/service_pb'
import { buildTemporalConfigEffect, type TemporalConfigLayerOptions } from './config-layer'

type ClosableTransport = Transport & { close?: () => void | Promise<void> }
type WorkflowServiceClient = ReturnType<typeof createClient<typeof WorkflowService>>

export class TemporalConfigService extends Context.Tag('@proompteng/temporal-bun-sdk/TemporalConfig')<
  TemporalConfigService,
  TemporalConfig
>() {}

export class LoggerService extends Context.Tag('@proompteng/temporal-bun-sdk/Logger')<LoggerService, Logger>() {}

export class MetricsService extends Context.Tag('@proompteng/temporal-bun-sdk/Metrics')<
  MetricsService,
  MetricsRegistry
>() {}

export class MetricsExporterService extends Context.Tag('@proompteng/temporal-bun-sdk/MetricsExporter')<
  MetricsExporterService,
  MetricsExporter
>() {}

export class ObservabilityService extends Context.Tag('@proompteng/temporal-bun-sdk/ObservabilityServices')<
  ObservabilityService,
  ObservabilityServices
>() {}

export class WorkflowServiceClientService extends Context.Tag('@proompteng/temporal-bun-sdk/WorkflowServiceClient')<
  WorkflowServiceClientService,
  WorkflowServiceClient
>() {}

export interface WorkflowServiceLayerOptions {
  interceptors?: TemporalInterceptor[]
  interceptorBuilder?: InterceptorBuilder
  identity?: string
  namespace?: string
}

const closeTransport = (transport: ClosableTransport | undefined) =>
  transport?.close
    ? Effect.tryPromise(async () => {
        await transport.close?.()
      })
    : Effect.void

export const createWorkflowServiceLayer = (
  options: WorkflowServiceLayerOptions = {},
): Layer.Layer<
  TemporalConfigService | LoggerService | MetricsService | MetricsExporterService,
  unknown,
  WorkflowServiceClientService
> =>
  Layer.scoped(
    WorkflowServiceClientService,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const config = yield* Effect.service(TemporalConfigService)
        const logger = yield* Effect.service(LoggerService)
        const metricsRegistry = yield* Effect.service(MetricsService)
        const metricsExporter = yield* Effect.service(MetricsExporterService)
        const interceptorBuilder = options.interceptorBuilder ?? makeDefaultInterceptorBuilder()
        const defaultInterceptors = yield* interceptorBuilder.build({
          namespace: options.namespace ?? config.namespace,
          identity: options.identity ?? config.workerIdentity,
          logger,
          metricsRegistry,
          metricsExporter,
        })
        const interceptors = [...defaultInterceptors, ...(options.interceptors ?? [])]
        const shouldUseTls = Boolean(config.tls || config.allowInsecureTls)
        const baseUrl = normalizeTemporalAddress(config.address, shouldUseTls)
        const transportOptions = buildTransportOptions(baseUrl, config, interceptors)
        const transport = createGrpcTransport(transportOptions) as ClosableTransport
        const workflowService = createClient(WorkflowService, transport)
        return { workflowService, transport }
      }),
      ({ transport }) => closeTransport(transport),
    ).pipe(Effect.map(({ workflowService }) => workflowService)),
  )

export const createConfigLayer = (
  options: TemporalConfigLayerOptions = {},
): Layer.Layer<never, TemporalConfigError | TemporalTlsConfigurationError, TemporalConfigService> =>
  Layer.effect(TemporalConfigService, buildTemporalConfigEffect(options))

export const ConfigLayer = createConfigLayer()

export interface ObservabilityLayerOptions extends ObservabilityOverrides {}

const buildObservabilityContext = (options: ObservabilityLayerOptions = {}) =>
  Layer.scopedContext(
    Effect.gen(function* () {
      const config = yield* Effect.service(TemporalConfigService)
      const services = yield* createObservabilityServices(
        {
          logLevel: config.logLevel,
          logFormat: config.logFormat,
          metrics: config.metricsExporter,
        },
        options,
      )
      let context = Context.make(ObservabilityService, services)
      context = Context.add(context, LoggerService, services.logger)
      context = Context.add(context, MetricsService, services.metricsRegistry)
      context = Context.add(context, MetricsExporterService, services.metricsExporter)
      return context
    }),
  )

export const createObservabilityLayer = (options: ObservabilityLayerOptions = {}) => buildObservabilityContext(options)

export const ObservabilityLayer = createObservabilityLayer()

export const LoggerLayer = ObservabilityLayer
export const MetricsLayer = ObservabilityLayer
export const MetricsExporterLayer = ObservabilityLayer

export const WorkflowServiceLayer = createWorkflowServiceLayer()
