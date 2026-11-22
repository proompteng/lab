import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  renameSync,
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
    request.mockResolvedValueOnce(json(TASK))
    const uploaded = await call('upload', {
      sessionId: 'session-paperless',
      path: 'invoice.txt',
      title: 'Invoice',
      tagIds: [2, 3],
    })
    expect(uploaded.structuredContent).toMatchObject({ taskId: TASK, bytes: 17, filename: 'invoice.txt' })
    const form = request.mock.calls[0][1]?.body as FormData
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
})
