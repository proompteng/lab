import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentsShellConfigFromEnv } from './config'
import { AgentsShellRunner } from './runner'
import { createAgentsShellServer } from './server'

let directory: string
let root: string
let runner: AgentsShellRunner
let client: Client
let server: ReturnType<typeof createAgentsShellServer>

const connect = async (scopes = new Set(['agents-shell.read'])) => {
  const config = { ...defaultAgentsShellConfigFromEnv({}), workspaceRoot: root, auditLogPath: null }
  runner = new AgentsShellRunner(config)
  server = createAgentsShellServer(config, runner, {
    subject: 'synthetic-user',
    email: null,
    username: null,
    scopes,
    payload: {},
  })
  client = new Client({ name: 'diagnostic-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'agents-diagnostic-mcp-'))
  root = join(directory, 'workspace')
  mkdirSync(root)
  await connect()
})

afterEach(async () => {
  await client.close()
  await server.close()
  runner.shutdown()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('diagnostic MCP boundaries', () => {
  it('rechecks ownership if the path changes after the initial authorization', async () => {
    const worktree = join(root, 'worktrees', 'lab', 'other-owner')
    mkdirSync(worktree, { recursive: true })
    const foreign = join(worktree, 'sample.json')
    writeFileSync(foreign, '{"marker":"other-owner-private"}')
    runner.repoSessions.set({
      id: 'other-session',
      ownerSubject: 'other-user',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      branch: 'codex/other-owner',
      worktree,
      createdAt: '2026-01-01T00:00:00Z',
    })
    const resolveCwd = runner.resolveCwd.bind(runner)
    for (const name of ['read_file', 'file_read_range', 'evidence_inspect']) {
      const path = join(root, `${name}.json`)
      writeFileSync(path, '{}')
      const check = vi.spyOn(runner, 'resolveCwd').mockImplementationOnce((...args) => {
        const result = resolveCwd(...args)
        unlinkSync(path)
        symlinkSync(foreign, path)
        return result
      })
      try {
        const result = await client.callTool({
          name,
          arguments: name === 'evidence_inspect' ? { path, format: 'json' } : { path },
        })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).not.toContain('other-owner-private')
      } finally {
        check.mockRestore()
      }
    }
  })

  it('enforces session ownership for direct paths and internal symlink targets', async () => {
    const worktree = join(root, 'worktrees', 'lab', 'other-owner')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, 'sample.json'), '{"marker":"other-owner-private"}')
    runner.repoSessions.set({
      id: 'other-session',
      ownerSubject: 'other-user',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      branch: 'codex/other-owner',
      worktree,
      createdAt: '2026-01-01T00:00:00Z',
    })
    symlinkSync(join(worktree, 'sample.json'), join(root, 'alias.json'))
    for (const path of [join(worktree, 'sample.json'), 'alias.json']) {
      for (const name of ['read_file', 'file_read_range', 'evidence_inspect']) {
        const result = await client.callTool({
          name,
          arguments: name === 'evidence_inspect' ? { path, format: 'json' } : { path },
        })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).not.toContain('other-owner-private')
      }
    }
  })

  it('prevents an existing file-read tool from following a workspace escape', async () => {
    writeFileSync(join(directory, 'outside.txt'), 'synthetic-private-marker')
    symlinkSync(join(directory, 'outside.txt'), join(root, 'escape.txt'))
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'escape.txt' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('synthetic-private-marker')
  })

  it('advertises actual read-only operations without command or SQL parameters', async () => {
    const { tools } = await client.listTools()
    for (const name of ['file_read_range', 'evidence_inspect', 'postgres_log_summary']) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool).toBeDefined()
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      expect(tool?.inputSchema.properties).not.toHaveProperty('command')
      expect(tool?.inputSchema.properties).not.toHaveProperty('sql')
      expect(tool?.inputSchema.properties).not.toHaveProperty('url')
      expect(tool?.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('performs bounded file paging and evidence inspection without spawning a process', async () => {
    const start = vi.spyOn(runner, 'start')
    const process = vi.spyOn(runner, 'runProcess')
    writeFileSync(join(root, 'sample.json'), '[1,2,3]')
    const page = await client.callTool({ name: 'file_read_range', arguments: { path: 'sample.json', maxBytes: 2 } })
    expect(page.isError).not.toBe(true)
    expect(page.structuredContent).toMatchObject({ content: '[1', nextOffset: 2, endOfFile: false })
    const info = await client.callTool({ name: 'evidence_inspect', arguments: { path: 'sample.json', format: 'json' } })
    expect(info.isError).not.toBe(true)
    expect(info.structuredContent).toMatchObject({ arrayDocuments: 1, topLevelArrayElements: 3, completeFile: true })
    expect(start).not.toHaveBeenCalled()
    expect(process).not.toHaveBeenCalled()
  })

  it('rejects unknown fields and caller-supplied code before processing', async () => {
    writeFileSync(join(root, 'sample.json'), '{}')
    for (const field of ['command', 'sql', 'url']) {
      const result = await client.callTool({
        name: 'evidence_inspect',
        arguments: { path: 'sample.json', format: 'json', [field]: 'not-executable' },
      })
      expect(result.isError).toBe(true)
    }
    const oversized = await client.callTool({
      name: 'file_read_range',
      arguments: { path: 'sample.json', maxBytes: 200001 },
    })
    expect(oversized.isError).toBe(true)
  })

  it('validates multiline JSON streams through the registered tool schema', async () => {
    writeFileSync(join(root, 'stream.json'), '{\n"synthetic": true\n}\n[1,2]\n')
    const result = await client.callTool({
      name: 'evidence_inspect',
      arguments: { path: 'stream.json', format: 'json-stream' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      format: 'json-stream',
      documentCount: 2,
      objectDocuments: 1,
      arrayDocuments: 1,
      topLevelArrayElements: 2,
    })
  })

  it('retains authorization requirements for diagnostics', async () => {
    await client.close()
    await server.close()
    runner.shutdown()
    await connect(new Set())
    writeFileSync(join(root, 'sample.json'), '{}')
    const result = await client.callTool({
      name: 'evidence_inspect',
      arguments: { path: 'sample.json', format: 'json' },
    })

    expect(result.isError).toBe(true)
  })

  it('honors a stricter configured page cap', async () => {
    runner.config.maxOutputBytes = 4
    runner.config.defaultOutputBytes = 4
    writeFileSync(join(root, 'sample.txt'), 'bounded')
    const page = await client.callTool({ name: 'file_read_range', arguments: { path: 'sample.txt' } })
    expect(page.structuredContent).toMatchObject({ content: 'boun', nextOffset: 4 })
    const result = await client.callTool({ name: 'file_read_range', arguments: { path: 'sample.txt', maxBytes: 5 } })
    expect(result.isError).toBe(true)
  })
})
