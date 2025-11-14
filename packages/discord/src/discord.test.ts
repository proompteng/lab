import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as discord from './index'

const { buildChannelName, chunkContent, consumeChunks, bootstrapChannel, streamChannel, iterableFromStream } = discord

const config: discord.DiscordConfig = {
  botToken: 'test-token',
  guildId: 'guild-123',
}

const originalFetch = global.fetch

describe('discord helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('chunks content respecting the message limit', () => {
    const text = 'a'.repeat(2005)
    const { chunks, remainder } = consumeChunks(text, 1000)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]?.length).toBe(1000)
    expect(remainder.length).toBeLessThan(1000)
    const all = chunkContent(text, 1000)
    expect(all.reduce((total, part) => total + part.length, 0)).toBe(2005)
  })

  it('builds channel names based on metadata', () => {
    const name = buildChannelName({ repository: 'proompteng/lab', issueNumber: 42, stage: 'plan' })
    expect(name).toContain('lab')
    expect(name).toContain('issue-42')
    expect(name).toContain('plan')
  })

  it('generates dry-run channel metadata', async () => {
    const logs: string[] = []
    const metadata: discord.ChannelMetadata = {
      repository: 'proompteng/lab',
      issueNumber: 77,
      stage: 'implementation',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }
    const channel = await bootstrapChannel(config, metadata, {
      dryRun: true,
      echo: (line) => logs.push(line),
    })
    expect(channel.channelId).toBe('dry-run')
    expect(channel.channelName).toContain('lab')
    expect(logs[0]).toContain('Would create channel')
    expect(logs[1]).toContain('Codex Channel Started')
  })

  it('streams chunks in dry-run mode', async () => {
    const echoes: string[] = []
    const channel: discord.ChannelBootstrapResult = {
      channelId: 'dry-run',
      channelName: 'codex-run',
      guildId: config.guildId,
      url: `https://discord.com/channels/${config.guildId}/dry-run`,
    }
    async function* generator() {
      yield 'Line A'
      yield 'Line B'
    }
    await streamChannel(config, channel, generator(), {
      dryRun: true,
      echo: (line) => echoes.push(line),
    })
    expect(echoes).toEqual(['[dry-run] Line A', '[dry-run] Line B'])
  })

  it('streams messages to Discord when enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as typeof fetch
    global.fetch = fetchMock
    const channel: discord.ChannelBootstrapResult = {
      channelId: 'chan-1',
      channelName: 'codex-channel',
      guildId: config.guildId,
      url: `https://discord.com/channels/${config.guildId}/chan-1`,
    }
    async function* generator() {
      yield 'line one\n'
      yield 'line two\nline three'
    }
    await streamChannel(config, channel, generator())
    expect(fetchMock).toHaveBeenCalled()
  })

  it('creates async iterator from Node streams', async () => {
    const readable = Readable.from(['alpha', Buffer.from('beta')])
    const collected: string[] = []
    for await (const chunk of iterableFromStream(readable)) {
      collected.push(chunk)
    }
    expect(collected).toEqual(['alpha', 'beta'])
  })
})
