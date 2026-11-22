import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import {
  READ_SCOPES,
  WRITE_SCOPES,
  REPLY_META_RESERVE_BYTES,
  openReadOnlyAnnotations,
  shellAnnotations,
} from './constants'
import { agentsShellErrorFromUnknown } from './errors'
import { type EffectTool, type EffectToolContext, toolSecurityMeta } from './mcp-adapter'
import { jsonTextResult } from './results'
import { EmptyInputSchema } from './schemas'
import { isInsidePath, resolveWorkspacePath } from './workspace-policy'

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
const FILE_TRANSFER_TIMEOUT_MS = 600000
const FILE_CHUNK_BYTES = 64 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024
const API_VERSION = 'application/json; version=10'
const ID = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
)
const text = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)))
const integer = (min: number, max: number) =>
  Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: min, maximum: max })))
const ids = Schema.Array(ID).pipe(Schema.check(Schema.isMaxLength(100)))
const date = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)))
const taskId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)),
)
const paging = {
  page: Schema.optionalKey(integer(1, 1000000)),
  pageSize: Schema.optionalKey(integer(1, 25)),
}
const metadataKinds = ['tags', 'correspondents', 'document_types', 'custom_fields', 'storage_paths'] as const
const metadataChanges = {
  title: Schema.optionalKey(text(128)),
  created: Schema.optionalKey(date),
  correspondent: Schema.optionalKey(Schema.NullOr(ID)),
  document_type: Schema.optionalKey(Schema.NullOr(ID)),
  storage_path: Schema.optionalKey(Schema.NullOr(ID)),
  tags: Schema.optionalKey(ids),
  custom_fields: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        field: ID,
        value: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(8192))),
          Schema.Number,
          Schema.Boolean,
          Schema.Null,
          ids,
        ]),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(100))),
  ),
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Paperless returned an invalid object.')
  return value as Record<string, unknown>
}

const positiveId = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Paperless returned an invalid document ID.')
  return value as number
}

const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))

const documentFields = [
  'id',
  'title',
  'created',
  'added',
  'modified',
  'correspondent',
  'document_type',
  'storage_path',
  'tags',
  'archive_serial_number',
  'original_file_name',
] as const
const documentMetadata = (value: unknown, detail = false) => {
  const document = record(value)
  positiveId(document.id)
  if (typeof document.title !== 'string') throw new Error('Paperless returned an invalid document title.')
  return pick(document, detail ? [...documentFields, 'custom_fields', 'mime_type', 'page_count'] : documentFields)
}

const consumeBody = async (
  response: Response,
  limit: number,
  consume: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> => {
  const oversized = () => new Error('Paperless response exceeds the size limit of ' + limit + ' bytes.')
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw oversized()
  }
  if (!response.body) throw new Error('Paperless returned an empty response.')
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch {
        throw new Error('Paperless response failed or timed out.')
      }
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw oversized()
      await consume(chunk.value)
    }
    return bytes
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const readBody = async (response: Response, limit: number): Promise<Buffer> => {
  const chunks: Uint8Array[] = []
  const bytes = await consumeBody(response, limit, (chunk) => {
    chunks.push(chunk)
  })
  return Buffer.concat(chunks, bytes)
}

export class PaperlessClient {
  readonly maxFileBytes: number
  private readonly base: URL
  private readonly tokenFile: string

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = new URL(env.AGENTS_SHELL_PAPERLESS_URL || 'http://paperless.paperless.svc.cluster.local:8000')
    if (
      !['http:', 'https:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      this.base.pathname !== '/'
    ) {
      throw new Error('AGENTS_SHELL_PAPERLESS_URL must be an HTTP(S) service origin.')
    }
    this.tokenFile = env.AGENTS_SHELL_PAPERLESS_TOKEN_FILE || '/var/run/secrets/agents-shell-paperless/token'
    const limit = env.AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES?.trim()
    this.maxFileBytes = limit === undefined ? DEFAULT_MAX_FILE_BYTES : Number(limit)
    if (
      (limit !== undefined && !/^\d+$/.test(limit)) ||
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes < 1
    ) {
      throw new Error('AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES must be a positive safe integer.')
    }
  }

  async request(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PATCH'
      query?: Record<string, string>
      body?: Record<string, unknown>
      multipart?: { body: ReadableStream<Uint8Array>; boundary: string; contentLength: number }
      timeoutMs?: number
      signal?: AbortSignal
    } = {},
  ) {
    let token: string
    try {
      token = (await readFile(this.tokenFile, 'utf8')).trim()
    } catch {
      throw new Error('Paperless API credential is unavailable.')
    }
    if (!/^[a-z0-9]{40}$/i.test(token)) throw new Error('Paperless API credential is invalid.')
    const url = new URL(path, this.base)
    if (url.origin !== this.base.origin || !url.pathname.startsWith('/api/'))
      throw new Error('Invalid Paperless API route.')
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
    const headers: Record<string, string> = { Authorization: 'Token ' + token, Accept: API_VERSION }
    if (options.multipart) {
      headers['Content-Type'] = 'multipart/form-data; boundary=' + options.multipart.boundary
      headers['Content-Length'] = String(options.multipart.contentLength)
    } else if (options.body) headers['Content-Type'] = 'application/json'
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30000)
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.multipart?.body ?? (options.body ? JSON.stringify(options.body) : undefined),
        ...(options.multipart ? { duplex: 'half' } : {}),
        redirect: 'manual',
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      })
    } catch {
      throw new Error('Paperless request failed or timed out. Check task or document state before retrying a write.')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        'Paperless API returned HTTP ' + response.status + '. Verify account permissions and service health.',
      )
    }
    return response
  }

  async json(path: string, options: Parameters<PaperlessClient['request']>[1] = {}) {
    const response = await this.request(path, options)
    const body = await readBody(response, MAX_JSON_BYTES)
    let value: unknown
    try {
      value = JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error('Paperless returned invalid JSON.')
    }
    return { value, version: response.headers.get('x-version'), apiVersion: response.headers.get('x-api-version') }
  }
}

const pageResult = (value: unknown, page: number, project: (item: unknown) => unknown) => {
  const data = record(value)
  if (!Array.isArray(data.results) || !Number.isSafeInteger(data.count) || Number(data.count) < 0) {
    throw new Error('Paperless returned invalid pagination.')
  }
  return { count: data.count, page, nextPage: data.next ? page + 1 : null, results: data.results.map(project) }
}

const filePath = async (root: string, path: string, exists: boolean) => {
  const canonicalRoot = await realpath(root)
  const candidate = resolveWorkspacePath(canonicalRoot, path)
  const segments = relative(canonicalRoot, candidate).split(/[\\/]/)
  if (segments.some((segment) => segment.startsWith('.')) || /\.(?:pem|key|p12|pfx)$/i.test(candidate)) {
    throw new Error('Document paths must exclude hidden files, credentials, and private keys.')
  }
  const canonical = exists
    ? await realpath(candidate)
    : resolve(await realpath(dirname(candidate)), basename(candidate))
  if (!isInsidePath(canonicalRoot, canonical)) throw new Error('Document path must stay inside the owned repo session.')
  if (
    relative(canonicalRoot, canonical)
      .split(/[\\/]/)
      .some((segment) => segment.startsWith('.')) ||
    /\.(?:pem|key|p12|pfx)$/i.test(canonical)
  ) {
    throw new Error('Resolved document path must exclude hidden files, credentials, and private keys.')
  }
  return { canonicalRoot, path: canonical }
}

const verifyHandle = async (handle: FileHandle, root: string) => {
  const info = await handle.stat()
  if (!info.isFile()) throw new Error('Document must be a regular file.')
  // The deployed service is Linux; verify the opened file too, after resolving any parent symlinks.
  if (!isInsidePath(root, await realpath('/proc/self/fd/' + handle.fd))) {
    throw new Error('Opened document must stay inside the owned repo session.')
  }
  return info
}

const withSession = async <T>(
  context: EffectToolContext,
  sessionId: string,
  operation: (root: string) => Promise<T>,
) => {
  const session = context.runner.repoSessions.acquire(sessionId, context.auth)
  try {
    return await operation(session.worktree)
  } finally {
    context.runner.repoSessions.release(sessionId)
  }
}

const boundedResult = (value: Record<string, unknown>, context: EffectToolContext) => {
  const result = jsonTextResult(value)
  if (Buffer.byteLength(JSON.stringify(result)) + REPLY_META_RESERVE_BYTES > context.config.defaultOutputBytes) {
    throw new Error('Paperless result exceeds the reply limit. Reduce pageSize or contentLength.')
  }
  return result
}

const tool = <I>(
  name: string,
  title: string,
  description: string,
  inputSchema: Schema.Codec<I, any>,
  writes: boolean,
  run: (client: PaperlessClient, input: I, context: EffectToolContext) => Promise<Record<string, unknown>>,
): EffectTool<I> => ({
  name,
  title,
  description,
  inputSchema,
  auditArguments: false,
  auditResult: false,
  annotations: writes ? shellAnnotations : openReadOnlyAnnotations,
  scopes: writes ? WRITE_SCOPES : READ_SCOPES,
  ...toolSecurityMeta([writes ? WRITE_SCOPES[0] : READ_SCOPES[0]]),
  handler: (input, context) =>
    Effect.tryPromise({
      try: async () => boundedResult(await run(new PaperlessClient(), input, context), context),
      catch: agentsShellErrorFromUnknown,
    }),
})

export const createPaperlessTools = (): EffectTool[] => [
  tool(
    'paperless_status',
    'Check Paperless API',
    'Check authenticated Paperless access, server/API version, visible document count and configured file limit.',
    EmptyInputSchema,
    false,
    async (client) => {
      const response = await client.json('/api/documents/', { query: { page_size: '1', fields: 'id' } })
      const data = record(response.value)
      if (!Number.isSafeInteger(data.count)) throw new Error('Paperless returned invalid document count.')
      return {
        connected: true,
        version: response.version,
        apiVersion: response.apiVersion,
        visibleDocuments: data.count,
        maxFileBytes: client.maxFileBytes,
      }
    },
  ),
  tool(
    'paperless_search',
    'Search Paperless documents',
    'Search visible documents by text or advanced query and metadata filters. Follow nextPage; use paperless_get_document for OCR text.',
    Schema.Struct({
      query: Schema.optionalKey(text(2048)),
      mode: Schema.optionalKey(Schema.Literals(['text', 'advanced'])),
      tagIds: Schema.optionalKey(ids),
      correspondentId: Schema.optionalKey(ID),
      documentTypeId: Schema.optionalKey(ID),
      createdAfter: Schema.optionalKey(date),
      createdBefore: Schema.optionalKey(date),
      ...paging,
    }),
    false,
    async (client, input) => {
      const page = input.page ?? 1
      const query: Record<string, string> = {
        page: String(page),
        page_size: String(input.pageSize ?? 10),
        fields: documentFields.join(','),
      }
      if (input.query) query[input.mode === 'advanced' ? 'query' : 'text'] = input.query
      if (input.tagIds?.length) query.tags__id__all = input.tagIds.join(',')
      if (input.correspondentId) query.correspondent__id = String(input.correspondentId)
      if (input.documentTypeId) query.document_type__id = String(input.documentTypeId)
      if (input.createdAfter) query.created__gte = input.createdAfter
      if (input.createdBefore) query.created__lte = input.createdBefore
      return pageResult((await client.json('/api/documents/', { query })).value, page, (value) =>
        documentMetadata(value),
      )
    },
  ),
  tool(
    'paperless_get_document',
    'Read Paperless document',
    'Read metadata and paged OCR text. Follow nextOffset as contentOffset. Default contentLength is 4000 characters.',
    Schema.Struct({
      documentId: ID,
      contentOffset: Schema.optionalKey(integer(0, Number.MAX_SAFE_INTEGER)),
      contentLength: Schema.optionalKey(integer(1, 8000)),
    }),
    false,
    async (client, input) => {
      const data = record((await client.json('/api/documents/' + input.documentId + '/')).value)
      if (typeof data.content !== 'string') throw new Error('Paperless returned invalid extracted text.')
      const offset = input.contentOffset ?? 0
      const content = data.content.slice(offset, offset + (input.contentLength ?? 4000))
      return {
        document: documentMetadata(data, true),
        content,
        contentOffset: offset,
        totalContentLength: data.content.length,
        nextOffset: offset + content.length < data.content.length ? offset + content.length : null,
      }
    },
  ),
  tool(
    'paperless_list_metadata',
    'List Paperless metadata',
    'List accessible tags, correspondents, document types, custom fields or storage paths. Follow nextPage and use returned IDs.',
    Schema.Struct({
      kind: Schema.Literals(metadataKinds),
      ...paging,
    }),
    false,
    async (client, input) => {
      const page = input.page ?? 1
      return pageResult(
        (
          await client.json('/api/' + input.kind + '/', {
            query: { page: String(page), page_size: String(input.pageSize ?? 10) },
          })
        ).value,
        page,
        (item) => {
          const data = record(item)
          return pick(data, [
            'id',
            'name',
            'color',
            'is_inbox_tag',
            'document_count',
            'data_type',
            'extra_data',
            'path',
          ])
        },
      )
    },
  ),
  tool(
    'paperless_create_metadata',
    'Create Paperless metadata',
    'Create a tag, correspondent or document type. List existing names first. color applies only to tags.',
    Schema.Struct({
      kind: Schema.Literals(['tags', 'correspondents', 'document_types']),
      name: text(128),
      color: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)))),
    }),
    true,
    async (client, input) => {
      if (input.color && input.kind !== 'tags') throw new Error('color is supported only for tags.')
      const data = record(
        (
          await client.json('/api/' + input.kind + '/', {
            method: 'POST',
            body: { name: input.name, ...(input.color ? { color: input.color } : {}) },
          })
        ).value,
      )
      return { metadata: pick(data, ['id', 'name', 'color']) }
    },
  ),
  tool(
    'paperless_upload',
    'Upload a document to Paperless',
    'Stream a session file within the configured limit (paperless_status). Poll paperless_get_task; check state before retrying.',
    Schema.Struct({
      sessionId: text(128),
      path: text(4096),
      title: Schema.optionalKey(text(128)),
      created: Schema.optionalKey(date),
      correspondentId: Schema.optionalKey(ID),
      documentTypeId: Schema.optionalKey(ID),
      tagIds: Schema.optionalKey(ids),
    }),
    true,
    async (client, input, context) =>
      withSession(context, input.sessionId, async (root) => {
        const target = await filePath(root, input.path, true)
        const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const abort = new AbortController()
        let body: ReadableStream<Uint8Array> | undefined
        try {
          const info = await verifyHandle(handle, target.canonicalRoot)
          if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > client.maxFileBytes)
            throw new Error('Document must be between 1 byte and ' + client.maxFileBytes + ' bytes.')
          const fields: [string, string][] = []
          if (input.title) fields.push(['title', input.title])
          if (input.created) fields.push(['created', input.created])
          if (input.correspondentId) fields.push(['correspondent', String(input.correspondentId)])
          if (input.documentTypeId) fields.push(['document_type', String(input.documentTypeId)])
          for (const tag of input.tagIds ?? []) fields.push(['tags', String(tag)])
          const boundary = 'paperless-' + randomUUID()
          const filename = basename(target.path)
          const quotedFilename = filename.replace(
            /[\r\n"\\]/g,
            (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
          )
          const prefix = Buffer.from(
            fields
              .map(
                ([name, value]) =>
                  '--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n',
              )
              .join('') +
              '--' +
              boundary +
              '\r\nContent-Disposition: form-data; name="document"; filename="' +
              quotedFilename +
              '"\r\nContent-Type: application/octet-stream\r\n\r\n',
          )
          const suffix = Buffer.from('\r\n--' + boundary + '--\r\n')
          const contentLength = prefix.byteLength + info.size + suffix.byteLength
          if (!Number.isSafeInteger(contentLength)) throw new Error('Document multipart size is too large.')
          const hash = createHash('sha256')
          let bytes = 0
          let complete = false
          let streamError: Error | undefined
          body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(prefix)
            },
            async pull(controller) {
              try {
                const current = await verifyHandle(handle, target.canonicalRoot)
                if (current.size !== info.size || current.mtimeMs !== info.mtimeMs)
                  throw new Error('Source file changed.')
                if (bytes < info.size) {
                  const chunk = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, info.size - bytes))
                  const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytes)
                  if (bytesRead < 1) throw new Error('Source file shrank.')
                  const sent = chunk.subarray(0, bytesRead)
                  bytes += bytesRead
                  hash.update(sent)
                  controller.enqueue(sent)
                  return
                }
                controller.enqueue(suffix)
                controller.close()
                complete = true
              } catch {
                streamError = new Error(
                  'Document changed or became unreadable during upload. Check task state before retrying.',
                )
                controller.error(streamError)
              }
            },
          })
          let result: unknown
          try {
            result = (
              await client.json('/api/documents/post_document/', {
                method: 'POST',
                multipart: { body, boundary, contentLength },
                timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
                signal: abort.signal,
              })
            ).value
          } catch (error) {
            throw streamError ?? error
          }
          if (!complete)
            throw new Error(
              'Paperless upload ended before the file was fully streamed. Check task state before retrying.',
            )
          await verifyHandle(handle, target.canonicalRoot)
          return {
            taskId: Schema.decodeUnknownSync(taskId)(result),
            filename,
            bytes,
            sha256: hash.digest('hex'),
          }
        } finally {
          abort.abort()
          await body?.cancel().catch(() => undefined)
          await handle.close()
        }
      }),
  ),
  tool(
    'paperless_get_task',
    'Check Paperless processing',
    'Read a processing task. API v10 statuses: pending/started/success/failure/revoked. Success includes relatedDocumentIds.',
    Schema.Struct({
      taskId,
    }),
    false,
    async (client, input) => {
      const data = pageResult(
        (await client.json('/api/tasks/', { query: { task_id: input.taskId, page_size: '25' } })).value,
        1,
        (item) => {
          const task = record(item)
          if (task.task_id !== input.taskId) throw new Error('Paperless returned a different task.')
          return {
            ...pick(task, ['id', 'task_id', 'status', 'date_created', 'date_started', 'date_done', 'result_data']),
            relatedDocumentIds: task.related_document_ids,
          }
        },
      )
      return { tasks: data.results }
    },
  ),
  tool(
    'paperless_update_document',
    'Update Paperless metadata',
    'Patch supplied metadata. tags/custom_fields replace whole lists; read existing values first. Null clears related metadata.',
    Schema.Struct({
      documentId: ID,
      changes: Schema.Struct(metadataChanges),
    }),
    true,
    async (client, input) => {
      if (Object.keys(input.changes).length === 0) throw new Error('Provide at least one metadata change.')
      const data = (
        await client.json('/api/documents/' + input.documentId + '/', { method: 'PATCH', body: input.changes })
      ).value
      return { document: documentMetadata(data), updatedFields: Object.keys(input.changes) }
    },
  ),
  tool(
    'paperless_download',
    'Download a Paperless document',
    'Stream original/archive into a new session file within the limit reported by paperless_status. Existing files are preserved.',
    Schema.Struct({
      documentId: ID,
      sessionId: text(128),
      path: text(4096),
      format: Schema.optionalKey(Schema.Literals(['original', 'archive'])),
    }),
    true,
    async (client, input, context) =>
      withSession(context, input.sessionId, async (root) => {
        const target = await filePath(root, input.path, false)
        const directory = await open(
          dirname(target.path),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        try {
          const anchoredDirectory = '/proc/self/fd/' + directory.fd
          if (!isInsidePath(target.canonicalRoot, await realpath(anchoredDirectory))) {
            throw new Error('Download directory must stay inside the owned repo session.')
          }
          // Keep creation and failure cleanup on the same directory, even if a caller renames its path while HTTP is pending.
          const anchoredPath = anchoredDirectory + '/' + basename(target.path)
          const handle = await open(
            anchoredPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          )
          let complete = false
          try {
            await verifyHandle(handle, target.canonicalRoot)
            const response = await client.request('/api/documents/' + input.documentId + '/download/', {
              query: { original: input.format === 'original' ? 'true' : 'false' },
              timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
            })
            const hash = createHash('sha256')
            const bytes = await consumeBody(response, client.maxFileBytes, async (chunk) => {
              await verifyHandle(handle, target.canonicalRoot)
              let offset = 0
              while (offset < chunk.byteLength) {
                const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
                if (bytesWritten < 1) throw new Error('Unable to write the downloaded document.')
                offset += bytesWritten
              }
              hash.update(chunk)
            })
            const saved = await verifyHandle(handle, target.canonicalRoot)
            const current = await lstat(anchoredPath)
            if (saved.dev !== current.dev || saved.ino !== current.ino || saved.size !== bytes)
              throw new Error('Download destination changed during transfer.')
            const savedPath = await realpath('/proc/self/fd/' + handle.fd)
            complete = true
            return {
              documentId: input.documentId,
              path: savedPath,
              bytes,
              sha256: hash.digest('hex'),
              contentType: response.headers.get('content-type'),
            }
          } finally {
            try {
              if (!complete) {
                const opened = await handle.stat()
                const current = await lstat(anchoredPath).catch(() => undefined)
                // Preserve a replacement file and the original transfer error during best-effort cleanup.
                if (current?.dev === opened.dev && current.ino === opened.ino)
                  await unlink(anchoredPath).catch(() => undefined)
              }
            } finally {
              await handle.close()
            }
          }
        } finally {
          await directory.close()
        }
      }),
  ),
  tool(
    'paperless_ai_suggestions',
    'Suggest document metadata with AI',
    'Request Flamingo metadata suggestions (up to 180s). Review before applying with paperless_update_document; needs change permission.',
    Schema.Struct({
      documentId: ID,
    }),
    true,
    async (client, input) => {
      const suggestions = record(
        (await client.json('/api/documents/' + input.documentId + '/ai_suggestions/', { timeoutMs: 180000 })).value,
      )
      return {
        documentId: input.documentId,
        suggestions: pick(suggestions, [
          'title',
          'correspondents',
          'suggested_correspondents',
          'tags',
          'suggested_tags',
          'document_types',
          'suggested_document_types',
          'storage_paths',
          'suggested_storage_paths',
          'dates',
        ]),
      }
    },
  ),
]
