import { afterEach, describe, expect, it, vi } from 'vitest'

import { approveTorghutWhitepaperForImplementation, streamTorghutWhitepaperPdf } from '../torghut-whitepapers'

describe('approveTorghutWhitepaperForImplementation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.JANGAR_WHITEPAPER_CONTROL_BASE_URL
    delete process.env.JANGAR_WHITEPAPER_CONTROL_TOKEN
    delete process.env.JANGAR_WHITEPAPER_SOURCE_ALLOWED_HOSTS
  })

  it('submits manual approval to Torghut with fixed jangar_ui source', async () => {
    process.env.JANGAR_WHITEPAPER_CONTROL_BASE_URL = 'http://torghut.internal/'
    process.env.JANGAR_WHITEPAPER_CONTROL_TOKEN = 'secret-token'

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run_id: 'wp-1', status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await approveTorghutWhitepaperForImplementation({
      runId: ' wp-1 ',
      approvedBy: 'ops@example.com',
      approvalReason: 'Manual override after operator review',
      targetScope: 'B1 candidate only',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/whitepaper-test',
      rolloutProfile: 'automatic',
    })

    expect(result).toEqual({ run_id: 'wp-1', status: 'completed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://torghut.internal/whitepapers/runs/wp-1/approve-implementation')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      approved_by: 'ops@example.com',
      approval_reason: 'Manual override after operator review',
      approval_source: 'jangar_ui',
      target_scope: 'B1 candidate only',
      repository: 'proompteng/lab',
      base: 'main',
      head: 'codex/whitepaper-test',
      rollout_profile: 'automatic',
    })
  })
})

describe('streamTorghutWhitepaperPdf', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.JANGAR_WHITEPAPER_SOURCE_ALLOWED_HOSTS
  })

  it('rejects untrusted and non-HTTPS source attachment URLs without fetching them', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      streamTorghutWhitepaperPdf({
        runId: 'wp-1',
        fileName: 'paper.pdf',
        cephBucket: null,
        cephObjectKey: null,
        sourceAttachmentUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    ).resolves.toBeNull()
    await expect(
      streamTorghutWhitepaperPdf({
        runId: 'wp-2',
        fileName: 'paper.pdf',
        cephBucket: null,
        cephObjectKey: null,
        sourceAttachmentUrl: 'https://example.com/paper.pdf',
      }),
    ).resolves.toBeNull()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('revalidates redirects and streams only PDF responses from trusted GitHub hosts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://private-user-images.githubusercontent.com/asset/paper.pdf' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('%PDF-1.7', {
          status: 200,
          headers: { 'content-type': 'application/pdf; charset=binary' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const response = await streamTorghutWhitepaperPdf({
      runId: 'wp-1',
      fileName: 'paper.pdf',
      cephBucket: null,
      cephObjectKey: null,
      sourceAttachmentUrl: 'https://github.com/user-attachments/assets/abc/paper.pdf',
    })

    expect(response?.headers.get('content-type')).toBe('application/pdf')
    await expect(response?.text()).resolves.toBe('%PDF-1.7')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://github.com/user-attachments/assets/abc/paper.pdf',
      'https://private-user-images.githubusercontent.com/asset/paper.pdf',
    ])
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: 'manual' })
  })

  it('rejects redirects to untrusted hosts and active non-PDF responses', async () => {
    const redirectFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/internal' },
      }),
    )
    vi.stubGlobal('fetch', redirectFetch)
    await expect(
      streamTorghutWhitepaperPdf({
        runId: 'wp-1',
        fileName: 'paper.pdf',
        cephBucket: null,
        cephObjectKey: null,
        sourceAttachmentUrl: 'https://github.com/user-attachments/assets/abc/paper.pdf',
      }),
    ).resolves.toBeNull()
    expect(redirectFetch).toHaveBeenCalledTimes(1)

    const htmlFetch = vi.fn().mockResolvedValue(
      new Response('<script>alert(1)</script>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    vi.stubGlobal('fetch', htmlFetch)
    await expect(
      streamTorghutWhitepaperPdf({
        runId: 'wp-2',
        fileName: 'paper.pdf',
        cephBucket: null,
        cephObjectKey: null,
        sourceAttachmentUrl: 'https://github.com/user-attachments/assets/def/paper.pdf',
      }),
    ).resolves.toBeNull()
  })
})
