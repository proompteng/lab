import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

export const observeCapacityIo = ({ port, bucket, sink, now = () => performance.now() }) => {
  const http = [],
    sql = [],
    serverSamples = [],
    stages = []
  const requests = new WeakMap(),
    pendingHeaders = new Map()
  const serverListeners = new Set()
  let inputAt = null,
    invalidatedAt = null,
    disposed = false,
    failure = null
  const fail = (message) => {
    failure ??= String(message).slice(0, 256)
  }
  const withinWindow = () => !disposed && (inputAt === null || now() <= inputAt + 1000)
  const phase = (at) =>
    inputAt === null || at < inputAt
      ? 'setup'
      : invalidatedAt === null || at < invalidatedAt
        ? 'input-before-invalidation'
        : 'input-after-invalidation'
  const safe =
    (fn) =>
    (...args) => {
      try {
        return fn(...args)
      } catch (error) {
        fail(error)
        return undefined
      }
    }
  const pathOf = (path) => new URL(path, 'http://fixture').pathname
  const created = safe(({ request }) => {
    if (!withinWindow() || request.getHeader('host') !== `127.0.0.1:${port}`) return
    const path = pathOf(request.path)
    if (!path.startsWith(`/${bucket}/research-capture/sha256/`)) return
    if (!['GET', 'PUT'].includes(request.method) || path.length > 256) return fail('Unexpected fixture HTTP identity')
    if (http.length >= 64) return fail('HTTP observation count exceeded 64')
    const at = now(),
      current = sink()
    const row = {
      ordinal: http.length,
      method: request.method,
      path,
      createdAt: at,
      createdPhase: phase(at),
      stage: current?.stage ?? null,
      stageOrdinal: current?.ioOrdinal ?? null,
      stageStartedAt: current?.began ?? null,
    }
    http.push(row)
    requests.set(request, row)
    const headers = safe((response) => {
      pendingHeaders.delete(request)
      row.headersAt = now()
      row.statusCode = Number.isInteger(response.statusCode) ? response.statusCode : null
    })
    pendingHeaders.set(request, headers)
    request.once('response', headers)
  })
  const started = safe(({ request }) => {
    const row = requests.get(request)
    if (row && !disposed) row.requestStartCallbackAt = now()
  })
  const ended = safe(({ request }) => {
    const row = requests.get(request)
    if (row && !disposed) {
      row.responseFinishDiagnosticCallbackAt = now()
      row.completedPhase = phase(row.responseFinishDiagnosticCallbackAt)
    }
  })
  const errored = safe(({ request }) => {
    const row = requests.get(request)
    if (row && !disposed) {
      row.errorCallbackAt = now()
      row.completedPhase = phase(row.errorCallbackAt)
    }
  })
  const subscriptions = [
    ['http.client.request.created', created],
    ['http.client.request.start', started],
    ['http.client.response.finish', ended],
    ['http.client.request.error', errored],
  ].map(([name, listener]) => {
    const source = channel(name)
    source.subscribe(listener)
    return [source, listener]
  })
  return {
    startInput: (at) => {
      inputAt = at
    },
    invalidate: () => {
      invalidatedAt ??= now()
    },
    withinWindow,
    serverStart: safe((method, path, response) => {
      if (disposed) return undefined
      const normalized = pathOf(path)
      const row = http.find(
        (value) => value.method === method && value.path === normalized && value.serverRequestAt === undefined,
      )
      if (row === undefined) {
        if (withinWindow()) fail('Server request had no matching client observation')
        return undefined
      }
      row.serverRequestAt = now()
      const cleanup = () => {
        response.off('finish', finish)
        response.off('close', close)
        serverListeners.delete(cleanup)
      }
      const finish = safe(() => {
        row.serverFinishCallbackAt = now()
        cleanup()
      })
      const close = safe(() => {
        row.serverCloseCallbackAt = now()
        cleanup()
      })
      serverListeners.add(cleanup)
      response.once('finish', finish)
      response.once('close', close)
      return row.ordinal
    }),
    serverMark: safe((ordinal, field) => {
      if (ordinal === undefined || disposed) return
      if (!['serverBodyConsumedAt', 'serverResponseEndCalledAt'].includes(field))
        return fail('Unexpected server marker')
      const row = http[ordinal]
      if (row === undefined) return fail('Missing server observation')
      row[field] = now()
    }),
    beginSink: safe((stage, bytes, began, chunk) => {
      if (!withinWindow()) return undefined
      if (stages.length >= 64) return fail('Sink observation count exceeded 64')
      if (
        typeof stage !== 'string' ||
        stage.length > 64 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > 4 * 1024 ** 2 ||
        !Number.isFinite(began)
      )
        return fail('Invalid sink observation')
      const row = {
        ordinal: stages.length,
        stage,
        bytes,
        startedAt: began,
        phase: phase(began),
        ...(stage === 'sql.append' && chunk
          ? { chunkOrdinal: chunk.ordinal, receipts: chunk.receipts, marketRecords: chunk.marketRecords }
          : {}),
      }
      stages.push(row)
      return row.ordinal
    }),
    endSink: safe((ordinal, success) => {
      if (ordinal === undefined || disposed) return
      const row = stages[ordinal]
      if (row === undefined) return fail('Missing sink observation')
      row.finishedAt = now()
      row.success = success
      row.completedPhase = phase(row.finishedAt)
    }),
    beginSql: safe((kind) => {
      if (!withinWindow()) return undefined
      if (sql.length >= 64) return fail('SQL observation count exceeded 64')
      if (!['lock', 'duplicate-read', 'frontier-read', 'chunk-insert', 'seal-insert', 'other'].includes(kind))
        return fail('Unexpected SQL kind')
      const row = {
        ordinal: sql.length,
        kind,
        stageOrdinal: sink()?.ioOrdinal ?? null,
        startedAt: now(),
        phase: phase(now()),
      }
      sql.push(row)
      return row.ordinal
    }),
    endSql: safe((ordinal, success) => {
      if (ordinal === undefined || disposed) return
      const row = sql[ordinal]
      if (row === undefined) return fail('Missing SQL observation')
      row.finishedAt = now()
      row.success = success
      row.completedPhase = phase(row.finishedAt)
    }),
    pgSample: safe((rows, requestedClientAt = now()) => {
      if (disposed || (inputAt !== null && requestedClientAt > inputAt + 1000)) return
      if (serverSamples.length >= 16) return fail('Server sample count exceeded 16')
      if (!Array.isArray(rows) || rows.length > 8) return fail('Unexpected server sample rows')
      const values = rows.map((row) => {
        const value = {}
        for (const key of ['pid', 'queryAgeMs', 'stateAgeMs']) {
          if (typeof row[key] !== 'number' || !Number.isFinite(row[key]))
            throw new Error('Invalid server numeric observation')
          value[key] = row[key]
        }
        for (const key of ['state', 'waitType', 'waitEvent', 'queryKind']) {
          if (row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 64))
            throw new Error('Invalid server text observation')
          value[key] = row[key]
        }
        return value
      })
      const at = now()
      serverSamples.push({
        requestedClientAt,
        observedClientAt: at,
        requestedPhase: phase(requestedClientAt),
        phase: phase(at),
        rows: values,
      })
    }),
    dispose: () => {
      disposed = true
      for (const [source, listener] of subscriptions) source.unsubscribe(listener)
      for (const [request, listener] of pendingHeaders) request.off('response', listener)
      pendingHeaders.clear()
      for (const cleanup of serverListeners) cleanup()
    },
    encodedReport: () => {
      const report = {
        instrumentedDiagnostic: true,
        capacityQualification: false,
        windowMs: 1000,
        inputAt,
        invalidatedAt,
        failure,
        http,
        sql,
        serverSamples,
        stages,
        limitations:
          'Client/server HTTP timestamps are same-process monotonic callback observations, not physical wire times. Node 24 response.finish is a response-header parser callback, not body consumption. PostgreSQL ages are computed solely on the server clock; catalog sampling adds diagnostic load. SQL tags exclude separate BEGIN/COMMIT and pool acquisition; concurrent work can delay all callbacks.',
      }
      const text = JSON.stringify({ capacityIoDiagnostics: report })
      if (Buffer.byteLength(text) + 1 <= 128 * 1024) return text
      return JSON.stringify({
        capacityIoDiagnostics: {
          instrumentedDiagnostic: true,
          capacityQualification: false,
          failure: 'Encoded diagnostic exceeded 128 KiB',
          omittedBytes: Buffer.byteLength(text),
          httpCount: http.length,
          sqlCount: sql.length,
          serverSampleCount: serverSamples.length,
          stageCount: stages.length,
        },
      })
    },
  }
}
