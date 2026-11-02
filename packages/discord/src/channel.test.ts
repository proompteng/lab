import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as discord from './channel'

const { buildChannelName, chunkContent, consumeChunks, DISCORD_MESSAGE_LIMIT } = discord

const originalFetch = global.fetch

describe('buildChannelName', () => {
  it('creates a stable channel name using repo slug, issue, stage, timestamp, and run id', () => {
    const channel = buildChannelName({
      repository: 'proompteng/lab',
      issueNumber: 1243,
      stage: 'planning',
      runId: 'channel-xyz123',
      createdAt: new Date('2025-10-07T12:34:56Z'),
    })

    expect(channel).toBe('lab-issue-1243-planning-20251007t1234-channel-xyz123')
  })

  it('trims long channel names without breaking semantics', () => {
    const channel = buildChannelName({
      repository: 'example/this-is-a-very-long-repository-name-with-many-segments',
      issueNumber: 42,
      stage: 'implementation',
      runId: 'abcdefghijklmno',
      createdAt: new Date('2025-10-07T12:34:56Z'),
    })

    expect(channel.length).toBeLessThanOrEqual(95)
    expect(channel).toMatch(/^this-is-a-very-long-repository-name-with-many-segments-issue-42-implementation-/)
  })
})

describe('chunkContent', () => {
  it('splits content into Discord-safe chunks prioritising newline boundaries', () => {
    const sample = Array.from({ length: 120 }, (_, index) => `line-${index.toString().padStart(3, '0')}`).join('\n')
    const { chunks, remainder } = consumeChunks(sample, 100)

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBeDefined()
    expect(chunks[0]?.endsWith('line-010')).toBeTruthy()
    expect(chunks[1]).toBeDefined()
    expect(chunks[1]?.startsWith('line-011')).toBeTruthy()
    expect(chunks.every((chunk) => chunk.length <= 100)).toBeTruthy()
    expect(chunks.at(-1)?.length ?? 0).toBeLessThanOrEqual(100)
    expect(remainder.startsWith('line-110')).toBeTruthy()
    expect(remainder.length).toBeLessThanOrEqual(100)
  })

  it('returns the original content when within the Discord limit', () => {
    const content = 'ok'.repeat(100)
    const chunks = chunkContent(content, DISCORD_MESSAGE_LIMIT)
    expect(chunks).toEqual([content])
  })
})

describe('createChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalFetch) {
      global.fetch = originalFetch
    }
  })

  it('uses an existing category when capacity is available', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'category-1', type: 4, name: 'Codex Channel - Radiant Horizon' },
          { id: 'channel-a', type: 0, parent_id: 'category-1' },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'channel-new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const config = { botToken: 'token', guildId: 'guild', categoryId: 'category-1' }
    const metadata = { repository: 'owner/repo', createdAt: new Date('2025-10-01T00:00:00Z') }

    const result = await discord.createChannel(config, metadata)

    expect(result.categoryId).toBe('category-1')
    expect(result.createdCategory).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/guilds/guild/channels',
      expect.objectContaining({ method: 'GET' }),
    )

    const [, createRequest] = fetchMock.mock.calls[1] ?? []
    expect(createRequest).toBeDefined()
    const body = JSON.parse(((createRequest as RequestInit)?.body ?? '{}') as string)
    expect(body.parent_id).toBe('category-1')
  })

  it('creates a new category with a fresh name when the configured one is full', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1)

    try {
      const channels = [
        { id: 'category-1', type: 4, name: 'Production Codex' },
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `channel-${index}`,
          type: 0,
          parent_id: 'category-1',
        })),
      ]

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(channels), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'category-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'channel-new' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const config = { botToken: 'token', guildId: 'guild', categoryId: 'category-1' }
      const metadata = { repository: 'owner/repo', createdAt: new Date('2025-10-01T00:00:00Z') }

      const result = await discord.createChannel(config, metadata)

      expect(result.categoryId).toBe('category-2')
      expect(result.createdCategory).toBe(true)
      expect(result.categoryName).toBe('Codex Channel - Sereine Salon')
      expect(fetchMock).toHaveBeenCalledTimes(3)

      const createCategoryCall = fetchMock.mock.calls[1]
      expect(createCategoryCall?.[0]).toBe('https://discord.com/api/v10/guilds/guild/channels')
      const createCategoryBody = JSON.parse(((createCategoryCall?.[1] as RequestInit)?.body ?? '{}') as string)
      expect(createCategoryBody.type).toBe(4)
      expect(createCategoryBody.name).toBe('Codex Channel - Sereine Salon')

      const createChannelCall = fetchMock.mock.calls[2]
      const createChannelBody = JSON.parse(((createChannelCall?.[1] as RequestInit)?.body ?? '{}') as string)
      expect(createChannelBody.parent_id).toBe('category-2')
    } finally {
      randomSpy.mockRestore()
    }
  })
})

describe('bootstrapChannel', () => {
  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch
    }
  })

  it('returns metadata in dry-run mode and echoes setup', async () => {
    const logs: string[] = []
    const config = { botToken: 'token', guildId: 'guild' }
    const metadata = {
      repository: 'owner/repo',
      issueNumber: 17,
      issueUrl: 'https://github.com/owner/repo/issues/17',
      stage: 'planning',
      runId: 'sample',
      createdAt: new Date('2025-10-11T00:00:00Z'),
      title: 'Sprint Planning',
    }

    const result = await discord.bootstrapChannel(config, metadata, {
      dryRun: true,
      echo: (line) => logs.push(line),
    })

    expect(result.channelId).toBe('dry-run')
    expect(logs[0]).toContain('[dry-run] Would create channel')
    expect(logs[1]).toContain('**Codex Channel Started**')
    expect(logs[1]).toContain('[owner/repo](https://github.com/owner/repo)')
    expect(logs[1]).toContain('[#17](https://github.com/owner/repo/issues/17)')
  })

  it('creates a channel and posts the initial message', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'channel-123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const config = { botToken: 'token', guildId: 'guild' }
    const metadata = {
      repository: 'owner/repo',
      issueNumber: 7,
      issueUrl: 'https://github.com/owner/repo/issues/7',
      stage: 'planning',
      createdAt: new Date('2025-10-01T00:00:00Z'),
    }

    const result = await discord.bootstrapChannel(config, metadata)

    expect(result.channelId).toBe('channel-123')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/guilds/guild/channels',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/guilds/guild/channels',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://discord.com/api/v10/channels/channel-123/messages',
      expect.objectContaining({ method: 'POST' }),
    )
    const messageRequest = fetchMock.mock.calls[2]?.[1] as RequestInit
    const messageBodyRaw = (messageRequest?.body as string) ?? '{}'
    const postMessageBody = JSON.parse(messageBodyRaw) as { content?: string }
    expect(postMessageBody.content).toContain('[owner/repo](https://github.com/owner/repo)')
    expect(postMessageBody.content).toContain('[#7](https://github.com/owner/repo/issues/7)')
    expect(postMessageBody.content).toContain('https://discord.com/channels/guild/channel-123')
  })

  it('echoes the newly created category name when a fresh category is required', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1)

    try {
      const channels = [
        { id: 'category-1', type: 4, name: 'Production Codex' },
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `channel-${index}`,
          type: 0,
          parent_id: 'category-1',
        })),
      ]

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(channels), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'category-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'channel-abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const config = { botToken: 'token', guildId: 'guild', categoryId: 'category-1' }
      const metadata = { repository: 'owner/repo', createdAt: new Date('2025-10-01T00:00:00Z') }
      const echoes: string[] = []

      await discord.bootstrapChannel(config, metadata, { echo: (line) => echoes.push(line) })

      expect(echoes[0]).toBe("Created Discord category 'Codex Channel - Sereine Salon' for Codex channel streams.")
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      randomSpy.mockRestore()
    }
  })
})

describe('streamChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalFetch) {
      global.fetch = originalFetch
    }
  })

  it('posts chunked messages for streamed content', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    global.fetch = fetchMock as unknown as typeof global.fetch

    const config = { botToken: 'token', guildId: 'guild' }
    const channelContext = { channelId: 'channel-xyz', channelName: 'name', guildId: 'guild' }

    const longMessage = 'x'.repeat(DISCORD_MESSAGE_LIMIT + 50)
    async function* generator() {
      yield longMessage
    }

    await discord.streamChannel(config, channelContext, generator())

    const payloads = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(([, init]) =>
      JSON.parse((init.body as string) ?? '{}'),
    )
    expect(payloads).toHaveLength(2)
    expect(payloads[0]?.content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)
    expect(payloads[1]?.content).toContain('x')
  })

  it('flushes messages separated by the message separator', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    global.fetch = fetchMock as unknown as typeof global.fetch

    const config = { botToken: 'token', guildId: 'guild' }
    const channelContext = { channelId: 'channel-xyz', channelName: 'name', guildId: 'guild' }

    async function* generator() {
      yield `first${discord.DISCORD_MESSAGE_SEPARATOR}second`
    }

    await discord.streamChannel(config, channelContext, generator())

    const payloads = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>).map(([, init]) =>
      JSON.parse((init.body as string) ?? '{}'),
    )
    expect(payloads).toHaveLength(2)
    expect(payloads[0]?.content).toContain('first')
    expect(payloads[1]?.content).toContain('second')
  })

  it('echoes output in dry-run mode without posting', async () => {
    const config = { botToken: 'token', guildId: 'guild' }
    const channelContext = { channelId: 'channel-xyz', channelName: 'name', guildId: 'guild' }
    const echoes: string[] = []

    async function* generator() {
      yield 'line-one'
      yield 'line-two'
    }

    await discord.streamChannel(config, channelContext, generator(), {
      dryRun: true,
      echo: (line) => echoes.push(line),
    })

    expect(echoes).toEqual(['[dry-run] line-one', '[dry-run] line-two'])
  })
})

describe('postMessage', () => {
  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch
    }
  })

  it('retries when Discord responds with rate limiting', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    await discord.postMessage({ botToken: 'token', guildId: 'guild' }, 'channel', 'content')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does nothing when content is empty', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof global.fetch

    await discord.postMessage({ botToken: 'token', guildId: 'guild' }, 'channel', '')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('iterableFromStream', () => {
  it('yields utf8 data from a readable stream', async () => {
    const stream = Readable.from(['chunk-a', Buffer.from('chunk-b')])
    const chunks: string[] = []

    for await (const chunk of discord.iterableFromStream(stream)) {
      chunks.push(chunk)
    }

    expect(chunks).toEqual(['chunk-a', 'chunk-b'])
  })
})
