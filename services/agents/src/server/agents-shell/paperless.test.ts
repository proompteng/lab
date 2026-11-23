import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { open, type FileHandle } from 'node:fs/promises'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  renameSync,
  statSync,
  truncateSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthContext } from './auth'
import { defaultAgentsShellConfigFromEnv } from './config'
import { PaperlessClient, createPaperlessTools } from './paperless'
import { AgentsShellRunner } from './runner'
import { createAgentsShellServer } from './server'

const realFetch = globalThis.fetch
const MIB = 1024 * 1024
const TOKEN = 'G9'.repeat(20)
const TASK = '77bcd3b2-799f-4a63-a591-98640c2e5e73'
const auth = (subject = 'owner', scopes = ['agents-shell.read']): AuthContext => ({
  subject,
  scopes: new Set(scopes),
  email: null,
  username: null,
  payload: { sub: subject },
})
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-version': '3.5.1', 'x-api-version': '10' },
  })
const page = (results: unknown[], next: string | null = null) => ({
  count: results.length,
  next,
  previous: null,
  results,
})
const document = {
  id: 12,
  title: 'Synthetic invoice',
  tags: [2],
  correspondent: null,
  content: 'ABCDEFGHIJKL',
  custom_fields: [],
}

describe('Paperless MCP tools', () => {
  let root: string
  let worktree: string
  let tokenFile: string
  let runner: AgentsShellRunner
  let client: Client
  let server: ReturnType<typeof createAgentsShellServer>
  let request: ReturnType<typeof vi.fn<typeof fetch>>

  const connect = async (identity = auth()) => {
    server = createAgentsShellServer(runner.config, runner, identity)
    client = new Client({ name: 'paperless-test', version: '1' })
    const [local, remote] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(remote), client.connect(local)])
  }
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: 'paperless_' + name, arguments: args })
  const requestUrl = (index = 0) => {
    const value = request.mock.calls[index][0]
    if (!(value instanceof URL)) throw new Error('Expected a URL request.')
    return value
  }
  const requestJson = () => {
    const value = request.mock.calls[0][1]?.body
    if (typeof value !== 'string') throw new Error('Expected a JSON request body.')
    return JSON.parse(value)
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'paperless-tools-'))
    worktree = join(root, 'worktrees', 'lab', 'fixture')
    mkdirSync(worktree, { recursive: true })
    tokenFile = join(root, 'token')
    writeFileSync(tokenFile, TOKEN)
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_URL', 'http://paperless.example.test:8000')
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_TOKEN_FILE', tokenFile)
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES', String(256 * MIB))
    runner = new AgentsShellRunner(
      defaultAgentsShellConfigFromEnv({
        AGENTS_SHELL_WORKSPACE_ROOT: root,
        AGENTS_SHELL_AUDIT_LOG_PATH: '',
      }),
    )
    runner.repoSessions.set({
      id: 'session-paperless',
      ownerSubject: 'owner',
      worktree,
      branch: 'codex/paperless-test',
      baseBranch: 'main',
      baseSha: 'b'.repeat(40),
      createdAt: new Date().toISOString(),
    })
    request = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', request)
    await connect()
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    runner.shutdown()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('checks authenticated version without returning document contents or credentials', async () => {
    request.mockResolvedValue(json(page([{ id: 12 }])))
    const result = await call('status')
    expect(result.structuredContent).toEqual({
      connected: true,
      version: '3.5.1',
      apiVersion: '10',
      visibleDocuments: 1,
      maxFileBytes: 256 * MIB,
    })
    const [, options] = request.mock.calls[0]
    expect(requestUrl().href).toBe('http://paperless.example.test:8000/api/documents/?page_size=1&fields=id')
    expect(options).toMatchObject({
      headers: { Authorization: 'Token ' + TOKEN, Accept: 'application/json; version=10' },
      redirect: 'manual',
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('keeps search filters encoded, strips OCR and emits numeric pagination', async () => {
    request.mockResolvedValue(
      json(page([{ ...document, owner: 5, permissions: { private: true } }], 'http://untrusted.invalid/next')),
    )
    const result = await call('search', {
      query: 'invoice&token=secret',
      mode: 'advanced',
      tagIds: [2, 3],
      createdAfter: '2026-01-01',
      page: 2,
    })

    const url = requestUrl()
    expect(url.searchParams.get('query')).toBe('invoice&token=secret')
    expect(url.searchParams.get('token')).toBeNull()
    expect(url.searchParams.get('tags__id__all')).toBe('2,3')
    expect(url.searchParams.get('created__gte')).toBe('2026-01-01')
    expect(result.structuredContent).toMatchObject({
      page: 2,
      nextPage: 3,
      results: [{ id: 12, title: 'Synthetic invoice' }],
    })
    expect(JSON.stringify(result)).not.toContain(document.content)
    expect(JSON.stringify(result)).not.toContain('untrusted.invalid')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('returns successive extracted text chunks with a continuation offset', async () => {
    request.mockImplementation(async () => json(document))
    const first = await call('get_document', { documentId: 12, contentLength: 5 })
    const second = await call('get_document', { documentId: 12, contentOffset: 5, contentLength: 7 })
    expect(first.structuredContent).toMatchObject({
      content: 'ABCDE',
      contentOffset: 0,
      nextOffset: 5,
      totalContentLength: 12,
    })
    expect(second.structuredContent).toMatchObject({ content: 'FGHIJKL', nextOffset: null })
  })

  it('rejects arbitrary routes, excess keys, permission changes and invalid bounds before any HTTP request', async () => {
    for (const [name, args] of [
      ['status', { url: 'http://attacker.invalid' }],
      ['search', { pageSize: 26 }],
      ['get_document', { documentId: 0 }],
      ['get_document', { documentId: 12, contentOffset: -1 }],
      ['list_metadata', { kind: '../../users' }],
      ['get_task', { taskId: 'bad/id' }],
      ['update_document', { documentId: 12, changes: { owner: 1 } }],
      ['update_document', { documentId: 12, changes: {} }],
      ['update_document', { documentId: 12, changes: { title: 'x'.repeat(129) } }],
    ] as const) {
      expect((await call(name, args)).isError).toBe(true)
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('fails missing scope before credentials or network access and keeps operation annotations honest', async () => {
    await client.close()
    await server.close()
    await connect(auth('owner', []))
    expect((await call('status')).isError).toBe(true)
    expect((await call('update_document', { documentId: 12, changes: { title: 'changed' } })).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
    const catalog = await client.listTools()
    for (const name of [
      'paperless_status',
      'paperless_search',
      'paperless_get_document',
      'paperless_list_metadata',
      'paperless_get_task',
    ]) {
      expect(catalog.tools.find((item) => item.name === name)?.annotations?.readOnlyHint).toBe(true)
    }
    for (const name of [
      'paperless_upload',
      'paperless_download',
      'paperless_update_document',
      'paperless_create_metadata',
      'paperless_ai_suggestions',
    ]) {
      expect(catalog.tools.find((item) => item.name === name)?.annotations?.readOnlyHint).toBe(false)
    }
  })

  it('never follows redirects or exposes upstream bodies and fetch exception secrets', async () => {
    request.mockResolvedValueOnce(
      new Response('upstream-private ' + TOKEN, { status: 302, headers: { location: 'http://attacker.invalid' } }),
    )
    expect(JSON.stringify(await call('status'))).toContain('HTTP 302')
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce(new Response('upstream-private ' + TOKEN, { status: 403 }))
    const denied = await call('status')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).not.toContain(TOKEN)
    expect(JSON.stringify(denied)).not.toContain('upstream-private')
    request.mockRejectedValueOnce(new Error('Authorization: Token ' + TOKEN))
    expect(JSON.stringify(await call('status'))).not.toContain(TOKEN)
    const api = new PaperlessClient({ AGENTS_SHELL_PAPERLESS_TOKEN_FILE: tokenFile }, request)
    await expect(api.request('http://attacker.invalid/api/documents/')).rejects.toThrow('Invalid Paperless API route')
  })

  it('bounds advertised, streamed and serialized response sizes', async () => {
    request.mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }))
    expect(JSON.stringify(await call('status'))).toContain('size limit')
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
            controller.close()
          },
        }),
      ),
    )
    expect(JSON.stringify(await call('status'))).toContain('size limit')
    request.mockResolvedValueOnce(json({ ...document, title: 'x'.repeat(20000) }))
    expect(JSON.stringify(await call('get_document', { documentId: 12 }))).toContain('reply limit')
  })

  it('uploads an owned file as multipart then reads API v10 task completion', async () => {
    writeFileSync(join(worktree, 'invoice.txt'), 'SYNTHETIC INVOICE')
    let form: FormData | undefined
    request.mockImplementationOnce(async (_url, options) => {
      form = await new Response(options?.body as ReadableStream<Uint8Array>, { headers: options?.headers }).formData()
      return json(TASK)
    })
    const uploaded = await call('upload', {
      sessionId: 'session-paperless',
      path: 'invoice.txt',
      title: 'Invoice',
      tagIds: [2, 3],
    })
    expect(uploaded.structuredContent).toMatchObject({ taskId: TASK, bytes: 17, filename: 'invoice.txt' })
    if (!form) throw new Error('Expected multipart form data.')
    expect(form.getAll('tags')).toEqual(['2', '3'])
    expect(form.get('title')).toBe('Invoice')
    expect(await (form.get('document') as Blob).text()).toBe('SYNTHETIC INVOICE')
    request.mockResolvedValueOnce(
      json(page([{ task_id: TASK, status: 'success', related_document_ids: [12], result_data: {} }])),
    )
    expect((await call('get_task', { taskId: TASK })).structuredContent).toMatchObject({
      tasks: [{ task_id: TASK, status: 'success', relatedDocumentIds: [12] }],
    })
    expect(requestUrl(1).searchParams.get('task_id')).toBe(TASK)
  })

  it('blocks cross-session, hidden and escaping symlink files before upload', async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside')
    writeFileSync(join(worktree, '.env'), 'private')
    symlinkSync(join(root, 'outside.txt'), join(worktree, 'escape.txt'))
    symlinkSync(join(worktree, '.env'), join(worktree, 'hidden.txt'))
    for (const path of ['../../outside.txt', '.env', 'escape.txt', 'hidden.txt']) {
      expect((await call('upload', { sessionId: 'session-paperless', path })).isError).toBe(true)
    }
    await client.close()
    await server.close()
    await connect(auth('other-owner'))
    expect((await call('upload', { sessionId: 'session-paperless', path: 'file.txt' })).isError).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('downloads original bytes exclusively and removes a failed download', async () => {
    request.mockResolvedValueOnce(new Response('PDF bytes', { headers: { 'content-type': 'application/pdf' } }))
    const result = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'result.pdf',
      format: 'original',
    })
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(worktree, 'result.pdf'), 'utf8')).toBe('PDF bytes')
    expect(requestUrl().searchParams.get('original')).toBe('true')
    expect(
      (await call('download', { sessionId: 'session-paperless', documentId: 12, path: 'result.pdf' })).isError,
    ).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce(new Response('failed', { status: 503 }))
    expect(
      (await call('download', { sessionId: 'session-paperless', documentId: 12, path: 'failed.pdf' })).isError,
    ).toBe(true)
    expect(existsSync(join(worktree, 'failed.pdf'))).toBe(false)
  })

  it('patches only explicit replacements and returns AI suggestions without applying them', async () => {
    request.mockResolvedValueOnce(json({ ...document, tags: [], correspondent: null }))
    expect(
      (await call('update_document', { documentId: 12, changes: { tags: [], correspondent: null, custom_fields: [] } }))
        .isError,
    ).toBeUndefined()
    expect(request.mock.calls[0][1]?.method).toBe('PATCH')
    expect(requestJson()).toEqual({
      tags: [],
      correspondent: null,
      custom_fields: [],
    })

    request.mockResolvedValueOnce(json({ title: 'Suggested invoice', tags: [2], suggested_tags: ['Finance'] }))
    expect((await call('ai_suggestions', { documentId: 12 })).structuredContent).toEqual({
      documentId: 12,
      suggestions: { title: 'Suggested invoice', tags: [2], suggested_tags: ['Finance'] },
    })
    expect(request.mock.calls[1][1]?.method).toBe('GET')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('fails unavailable or malformed credentials before making a request', async () => {
    rmSync(tokenFile)
    expect(JSON.stringify(await call('status'))).toContain('credential is unavailable')
    writeFileSync(tokenFile, TOKEN + '\nInjected: value')
    expect(JSON.stringify(await call('status'))).toContain('credential is invalid')
    expect(request).not.toHaveBeenCalled()
  })

  it('anchors failed download cleanup when its directory is replaced during HTTP', async () => {
    const output = join(worktree, 'output')
    const moved = join(worktree, 'output-moved')
    const victim = join(root, 'victim')
    mkdirSync(output)
    mkdirSync(victim)
    writeFileSync(join(victim, 'result.pdf'), 'PRESERVE EXISTING FILE')
    request.mockImplementationOnce(async () => {
      renameSync(output, moved)
      symlinkSync(victim, output)
      return new Response('failed', { status: 503 })
    })
    expect(
      (await call('download', { sessionId: 'session-paperless', documentId: 12, path: 'output/result.pdf' })).isError,
    ).toBe(true)
    expect(readFileSync(join(victim, 'result.pdf'), 'utf8')).toBe('PRESERVE EXISTING FILE')
    expect(existsSync(join(moved, 'result.pdf'))).toBe(false)
  })

  it('returns a successful compact update receipt when unchanged custom fields are large', async () => {
    request.mockResolvedValueOnce(json({ ...document, custom_fields: [{ field: 1, value: 'x'.repeat(20000) }] }))
    const result = await call('update_document', { documentId: 12, changes: { title: 'Updated title' } })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ document: { id: 12 }, updatedFields: ['title'] })
    expect(JSON.stringify(result)).not.toContain('custom_fields')
  })

  it('creates bounded metadata and excludes query/document payloads from audit frames', async () => {
    const audit = vi.spyOn(runner, 'audit')
    request.mockResolvedValueOnce(json({ id: 2, name: 'private-tag-name', color: '#123456' }))
    expect(
      (await call('create_metadata', { kind: 'tags', name: 'private-tag-name', color: '#123456' })).structuredContent,
    ).toMatchObject({ metadata: { id: 2 } })
    expect(requestJson()).toEqual({ name: 'private-tag-name', color: '#123456' })
    request.mockResolvedValueOnce(json(page([document])))
    await call('search', { query: 'private-query' })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private-tag-name')
    expect(JSON.stringify(audit.mock.calls)).not.toContain('private-query')
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Synthetic invoice')
    expect(createPaperlessTools().every((item) => item.auditArguments === false && item.auditResult === false)).toBe(
      true,
    )
  })

  it('validates the configurable file limit and reports the effective value', async () => {
    expect(new PaperlessClient({}, request).maxFileBytes).toBe(256 * MIB)
    for (const value of ['', '0', '-1', '1.5', 'Infinity', '1e8', '9007199254740992', 'invalid']) {
      expect(() => new PaperlessClient({ AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES: value }, request)).toThrow(
        'must be a positive safe integer',
      )
    }
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES', '1024')
    request.mockResolvedValueOnce(json(page([])))
    expect((await call('status')).structuredContent).toMatchObject({ maxFileBytes: 1024 })
    writeFileSync(join(worktree, 'oversized.pdf'), Buffer.alloc(1025))
    expect(JSON.stringify(await call('upload', { sessionId: 'session-paperless', path: 'oversized.pdf' }))).toContain(
      'between 1 byte and 1024 bytes',
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('streams uploads and downloads above 32 MiB with bounded chunks and matching hashes', async () => {
    const size = 33 * MIB
    const file = join(worktree, 'large.pdf')
    writeFileSync(file, '')
    truncateSync(file, size)
    const zeroChunk = Buffer.alloc(64 * 1024)
    const expectedHash = createHash('sha256')
    for (let offset = 0; offset < size; offset += zeroChunk.byteLength) expectedHash.update(zeroChunk)
    const digest = expectedHash.digest('hex')
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    request.mockImplementationOnce(async (_url, options) => {
      const body = options?.body
      if (!(body instanceof ReadableStream)) throw new Error('Expected a streamed upload.')
      const reader = body.getReader()
      const headers = new Headers(options?.headers)
      const length = Number(headers.get('content-length'))
      const hash = createHash('sha256')
      let total = 0
      let fileBytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          expect(chunk.value.byteLength).toBeLessThanOrEqual(64 * 1024)
          const first = total === 0
          total += chunk.value.byteLength
          if (!first && total !== length) {
            fileBytes += chunk.value.byteLength
            hash.update(chunk.value)
          }
        }
      } finally {
        reader.releaseLock()
      }
      expect(total).toBe(length)
      expect(fileBytes).toBe(size)
      expect(hash.digest('hex')).toBe(digest)
      return json(TASK)
    })
    const uploaded = await call('upload', { sessionId: 'session-paperless', path: 'large.pdf' })
    expect(uploaded.isError).toBeUndefined()
    expect(uploaded.structuredContent).toMatchObject({ taskId: TASK, bytes: size, sha256: digest })

    let produced = 0
    const destination = join(worktree, 'large-downloaded.pdf')
    request.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (produced > 2 * zeroChunk.byteLength) expect(statSync(destination).size).toBeGreaterThan(0)
              controller.enqueue(zeroChunk)
              produced += zeroChunk.byteLength
              if (produced === size) controller.close()
            },
          }),
          { headers: { 'content-length': String(size), 'content-type': 'application/pdf' } },
        ),
    )
    const downloaded = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'large-downloaded.pdf',
    })
    expect(downloaded.isError).toBeUndefined()
    expect(downloaded.structuredContent).toMatchObject({ bytes: size, sha256: digest })
    expect(statSync(destination).size).toBe(size)
    expect(timeout).toHaveBeenCalledWith(600000)
  })

  it('sends byte-accurate multipart over real HTTP with UTF-8 fields and a quoted filename', async () => {
    const filename = 'invoice-é"demo.txt'
    writeFileSync(join(worktree, filename), 'ORIGINAL FILE CONTENT')
    let receivedLength = 0
    let advertisedLength = 0
    let wireFilename: string | undefined
    let receivedForm: FormData | undefined
    let serverError: unknown
    const http = createServer(async (incoming, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        receivedLength = bytes.byteLength
        advertisedLength = Number(incoming.headers['content-length'])
        wireFilename = bytes.toString('utf8').match(/name="document"; filename="([^"]*)"/)?.[1]
        receivedForm = await new Response(bytes, {
          headers: { 'content-type': incoming.headers['content-type'] ?? '' },
        }).formData()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(TASK))
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end()
      }
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address.')
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_URL', 'http://127.0.0.1:' + address.port)
    request.mockImplementation((url, options) => realFetch(url, options))
    try {
      const result = await call('upload', {
        sessionId: 'session-paperless',
        path: filename,
        title: 'Résumé – 東京',
        tagIds: [2, 3],
      })
      expect(serverError).toBeUndefined()
      expect(result.isError).toBeUndefined()
      expect(receivedLength).toBe(advertisedLength)
      expect(receivedForm?.get('title')).toBe('Résumé – 東京')
      expect(receivedForm?.getAll('tags')).toEqual(['2', '3'])
      expect(wireFilename).toBe('invoice-é%22demo.txt')
      const file = receivedForm?.get('document') as File
      // Node decodes multipart percent escapes; Bun preserves them in File.name.
      expect(decodeURIComponent(file.name)).toBe(filename)
      expect(await file.text()).toBe('ORIGINAL FILE CONTENT')
    } finally {
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()))
        http.closeAllConnections()
      })
    }
  })

  it('keeps uploads on the verified inode when the pathname is replaced', async () => {
    const source = join(worktree, 'source.txt')
    writeFileSync(source, 'ORIGINAL CONTENT')
    request.mockImplementationOnce(async (_url, options) => {
      renameSync(source, join(worktree, 'source-original.txt'))
      writeFileSync(source, 'REPLACEMENT CONTENT')
      const form = await new Response(options?.body as ReadableStream<Uint8Array>, {
        headers: options?.headers,
      }).formData()
      expect(await (form.get('document') as Blob).text()).toBe('ORIGINAL CONTENT')
      return json(TASK)
    })
    expect((await call('upload', { sessionId: 'session-paperless', path: 'source.txt' })).isError).toBeUndefined()
  })

  it.each([8, 24])('rejects a source resized to %i bytes without finishing its multipart body', async (size) => {
    const source = join(worktree, 'changing.txt')
    writeFileSync(source, '1234567890123456')
    let received = ''
    let boundary = ''
    request.mockImplementationOnce(async (_url, options) => {
      truncateSync(source, size)
      boundary = new Headers(options?.headers).get('content-type')?.split('boundary=')[1] ?? ''
      const body = options?.body
      if (!(body instanceof ReadableStream)) throw new Error('Expected a streamed upload.')
      const reader = body.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          received += Buffer.from(chunk.value).toString('utf8')
        }
      } finally {
        reader.releaseLock()
      }
      return json(TASK)
    })
    const result = await call('upload', { sessionId: 'session-paperless', path: 'changing.txt' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Document changed')
    expect(received).not.toContain('--' + boundary + '--')
  })

  it.each([200, 403])('stops an upload after an early HTTP %i response', async (status) => {
    writeFileSync(join(worktree, 'early.txt'), 'SOURCE CONTENT')
    let body: ReadableStream<Uint8Array> | undefined
    let signal: AbortSignal | undefined | null
    request.mockImplementationOnce(async (_url, options) => {
      body = options?.body as ReadableStream<Uint8Array>
      signal = options?.signal
      return json(TASK, status)
    })
    expect((await call('upload', { sessionId: 'session-paperless', path: 'early.txt' })).isError).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(await body?.getReader().read()).toMatchObject({ done: true })
  })

  it('rejects advertised and streamed overflow, sanitizes cancellation, and removes partial files', async () => {
    vi.stubEnv('AGENTS_SHELL_PAPERLESS_MAX_FILE_BYTES', '1024')
    const canceled = vi.fn(() => {
      throw new Error('private transport failure ' + TOKEN)
    })
    request.mockImplementationOnce(
      async () => new Response(new ReadableStream({ cancel: canceled }), { headers: { 'content-length': '1025' } }),
    )
    const advertised = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'advertised.pdf',
    })
    expect(advertised.isError).toBe(true)
    expect(JSON.stringify(advertised)).toContain('size limit of 1024 bytes')
    expect(JSON.stringify(advertised)).not.toContain(TOKEN)
    expect(canceled).toHaveBeenCalledOnce()
    expect(existsSync(join(worktree, 'advertised.pdf'))).toBe(false)

    let chunks = 0
    request.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(chunks++ < 2 ? 512 : 1))
            },
            cancel: canceled,
          }),
        ),
    )
    const streamed = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'streamed.pdf',
    })
    expect(streamed.isError).toBe(true)
    expect(JSON.stringify(streamed)).toContain('size limit of 1024 bytes')
    expect(JSON.stringify(streamed)).not.toContain(TOKEN)
    expect(existsSync(join(worktree, 'streamed.pdf'))).toBe(false)
  })

  it('sanitizes midstream failures and preserves a replacement destination during cleanup', async () => {
    const target = join(worktree, 'replaced.pdf')
    let chunks = 0
    request.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (chunks++ < 2) {
                controller.enqueue(new Uint8Array(16))
                return
              }
              expect(statSync(target).size).toBeGreaterThan(0)
              renameSync(target, join(worktree, 'original-partial.pdf'))
              writeFileSync(target, 'PRESERVE REPLACEMENT')
              controller.error(new Error('transport credential ' + TOKEN))
            },
          }),
        ),
    )
    const result = await call('download', { sessionId: 'session-paperless', documentId: 12, path: 'replaced.pdf' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('response failed or timed out')
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(readFileSync(target, 'utf8')).toBe('PRESERVE REPLACEMENT')
  })

  it('writes no response bytes if the destination directory moves outside the session during HTTP', async () => {
    const probe = await open(join(worktree, 'probe'), 'w')
    const writes = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'write')
    await probe.close()
    const directory = join(worktree, 'output')
    const outside = join(root, 'moved-output')
    mkdirSync(directory)
    request.mockImplementationOnce(async () => {
      renameSync(directory, outside)
      return new Response('PRIVATE DOCUMENT BYTES')
    })
    const result = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'output/result.pdf',
    })
    expect(result.isError).toBe(true)
    expect(existsSync(join(outside, 'result.pdf'))).toBe(false)
    expect(writes).not.toHaveBeenCalled()
  })

  it('completes short file writes before requesting more download data', async () => {
    const probe = await open(join(worktree, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as FileHandle
    // oxlint-disable-next-line typescript/unbound-method -- Forward the actual destination handle through Reflect.apply.
    const originalWrite = prototype.write
    await probe.close()
    const partial = vi.spyOn(prototype, 'write').mockImplementation(function (
      this: FileHandle,
      buffer: Uint8Array | string,
      offset?: number | null,
      length?: number | BufferEncoding | null,
      position?: number | null,
    ) {
      if (typeof buffer === 'string') return originalWrite.call(this, buffer, offset, length as BufferEncoding)
      return Reflect.apply(originalWrite, this, [
        buffer,
        offset ?? 0,
        Math.min(Number(length), 3),
        position,
      ]) as ReturnType<FileHandle['write']>
    } as FileHandle['write'])
    request.mockResolvedValueOnce(new Response('DOCUMENT WITH SHORT WRITES'))
    const result = await call('download', {
      sessionId: 'session-paperless',
      documentId: 12,
      path: 'short-writes.txt',
    })
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(worktree, 'short-writes.txt'), 'utf8')).toBe('DOCUMENT WITH SHORT WRITES')
    expect(partial.mock.calls.length).toBeGreaterThan(1)
  })
})
