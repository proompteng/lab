import { OTLPTraceExporter } from '@proompteng/otel/exporter-trace-otlp-http'
import { Resource } from '@proompteng/otel/resources'
import { createSimpleSpanProcessor, SpanStatusCode, TracerProvider } from '@proompteng/otel/sdk-trace'

type AgentRunLifecycle = {
  name: string
  namespace: string
  runtime: string
  outcome: 'Succeeded' | 'Failed' | 'Cancelled'
  model?: string | null
  effort?: string | null
  startTime: number
  endTime: number
}

export const createAgentRunLifecycleRecorder = (env: NodeJS.ProcessEnv) => {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  const disabled = (_run: AgentRunLifecycle): undefined => undefined
  if (!endpoint) return disabled

  let url: URL
  try {
    url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('expected an uncredentialed HTTP(S) base URL')
    }
  } catch {
    console.warn('[agents] tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT must be an uncredentialed HTTP(S) base URL')
    return disabled
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/traces`
  const exporter = new OTLPTraceExporter({ url: url.href, protocol: 'http/protobuf', timeoutMillis: 3_000 })
  const provider = new TracerProvider({
    resource: new Resource({
      'service.name': env.OTEL_SERVICE_NAME?.trim() || env.AGENTS_SERVER_PROFILE?.trim() || 'agents',
    }),
  })
  provider.addSpanProcessor(createSimpleSpanProcessor(exporter))
  const tracer = provider.getTracer('agents.agentrun')

  return (run: AgentRunLifecycle) => {
    const span = tracer.startSpan('agents.agentrun.lifecycle', {
      startTime: run.startTime,
      attributes: {
        'agentrun.name': run.name,
        'k8s.namespace.name': run.namespace,
        'agentrun.runtime': run.runtime,
        'agentrun.outcome': run.outcome,
        ...(run.model ? { 'gen_ai.request.model': run.model } : {}),
        ...(run.effort ? { 'agentrun.reasoning_effort': run.effort } : {}),
      },
    })
    if (run.outcome === 'Failed') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(run.endTime)
    return span.spanContext().traceId
  }
}

let recordLifecycle: ReturnType<typeof createAgentRunLifecycleRecorder> | undefined

export const recordAgentRunLifecycleSpan = (run: AgentRunLifecycle) => {
  recordLifecycle ??= createAgentRunLifecycleRecorder(process.env)
  return recordLifecycle(run)
}
