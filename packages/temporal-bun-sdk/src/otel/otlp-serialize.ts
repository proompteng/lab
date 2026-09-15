import { attributesToKeyValueList, stableAttributesKey } from './otlp'
import type { SpanData } from './sdk-trace'

type SerializedSpanEvent = {
  name: string
  timeUnixNano: string
  attributes: ReturnType<typeof attributesToKeyValueList>
}

type SerializedSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanData['kind']
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: ReturnType<typeof attributesToKeyValueList>
  status?: SpanData['status']
  events?: SerializedSpanEvent[]
}

export type SerializedScopeSpans = {
  scope: SpanData['scope']
  spans: SerializedSpan[]
}

export type SerializedResourceSpans = {
  resource: { attributes: ReturnType<typeof attributesToKeyValueList> }
  scopeSpans: SerializedScopeSpans[]
}

export const serializeSpans = (spans: SpanData[]): { resourceSpans: SerializedResourceSpans[] } => {
  const resourceMap = new Map<
    string,
    {
      resourceAttributes: SpanData['resourceAttributes']
      scopeMap: Map<string, { scope: SpanData['scope']; spans: SpanData[] }>
    }
  >()

  for (const span of spans) {
    const resourceKey = stableAttributesKey(span.resourceAttributes)
    const scopeKey = `${span.scope.name}:${span.scope.version ?? ''}`
    let resourceEntry = resourceMap.get(resourceKey)
    if (!resourceEntry) {
      resourceEntry = {
        resourceAttributes: span.resourceAttributes,
        scopeMap: new Map(),
      }
      resourceMap.set(resourceKey, resourceEntry)
    }
    let scopeEntry = resourceEntry.scopeMap.get(scopeKey)
    if (!scopeEntry) {
      scopeEntry = { scope: span.scope, spans: [] }
      resourceEntry.scopeMap.set(scopeKey, scopeEntry)
    }
    scopeEntry.spans.push(span)
  }

  const resourceSpans: SerializedResourceSpans[] = []
  for (const resourceEntry of resourceMap.values()) {
    const scopeSpans: SerializedScopeSpans[] = []
    for (const scopeEntry of resourceEntry.scopeMap.values()) {
      scopeSpans.push({
        scope: scopeEntry.scope,
        spans: scopeEntry.spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: attributesToKeyValueList(span.attributes),
          ...(span.status ? { status: span.status } : {}),
          ...(span.events
            ? {
                events: span.events.map((event) => ({
                  name: event.name,
                  timeUnixNano: event.timeUnixNano,
                  attributes: attributesToKeyValueList(event.attributes),
                })),
              }
            : {}),
        })),
      })
    }
    resourceSpans.push({
      resource: {
        attributes: attributesToKeyValueList(resourceEntry.resourceAttributes),
      },
      scopeSpans,
    })
  }

  return { resourceSpans }
}
