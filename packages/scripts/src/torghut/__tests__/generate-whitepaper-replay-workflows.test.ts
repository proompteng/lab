import { describe, expect, it } from 'bun:test'

import { __private } from '../generate-whitepaper-replay-workflows'

describe('generate-whitepaper-replay-workflows', () => {
  it('prefers attachment_url from the marker block', () => {
    const body = `<!-- TORGHUT_WHITEPAPER:START -->
workflow: whitepaper-analysis-v1
base_branch: main
attachment_url: https://arxiv.org/pdf/2602.11917.pdf
<!-- TORGHUT_WHITEPAPER:END -->

Attachment: https://example.com/ignored.pdf`

    expect(__private.extractAttachmentUrl(body)).toBe('https://arxiv.org/pdf/2602.11917.pdf')
  })

  it('accepts arxiv pdf urls without a .pdf suffix', () => {
    expect(__private.looksLikePdfUrl('https://arxiv.org/pdf/2505.11122')).toBeTrue()
    expect(__private.extractPdfUrls('PDF: https://arxiv.org/pdf/2505.11122')).toEqual([
      'https://arxiv.org/pdf/2505.11122',
    ])
  })

  it('uses the body paper title for smoke and e2e issues', () => {
    const title = '[smoke] whitepaper trigger path A Janus-Q 20260224063432'
    const body = `<!-- TORGHUT_WHITEPAPER:START -->
workflow: whitepaper-analysis-v1
base_branch: main
attachment_url: https://arxiv.org/pdf/2602.19919.pdf
<!-- TORGHUT_WHITEPAPER:END -->

Paper: Janus-Q: End-to-End RL for Event-Driven Stock Trading with LLM Baselines`

    expect(__private.titleFromIssue(title, body, 'https://arxiv.org/pdf/2602.19919.pdf')).toBe(
      'Janus-Q: End-to-End RL for Event-Driven Stock Trading with LLM Baselines',
    )
  })

  it('deduplicates repeated attachment urls into one manifest item', () => {
    const outputDir = '/tmp/replay-workflows'
    const records = [
      {
        number: 3610,
        title: 'Analyze whitepaper: arXiv 2510.27251',
        body: '',
        url: 'https://github.com/proompteng/lab/issues/3610',
        closedAt: '2026-02-24T17:06:47Z',
        attachmentUrl: 'https://arxiv.org/pdf/2510.27251.pdf',
        paperTitle: 'FinPos: A Position-Aware Trading Agent System for Real Financial Markets',
      },
      {
        number: 3623,
        title: 'Analyze whitepaper: arXiv 2510.27251',
        body: '',
        url: 'https://github.com/proompteng/lab/issues/3623',
        closedAt: '2026-02-25T05:33:46Z',
        attachmentUrl: 'https://arxiv.org/pdf/2510.27251.pdf',
        paperTitle: 'FinPos: A Position-Aware Trading Agent System for Real Financial Markets',
      },
    ]

    const { manifest, payloads } = __private.buildManifest('proompteng/lab', records, outputDir)

    expect(manifest.uniqueWhitepaperCount).toBe(1)
    expect(manifest.items[0]?.sourceIssues.map((issue) => issue.number)).toEqual([3610, 3623])
    expect(payloads[0]?.payload.issue.number).toBe(900000001)
  })

  it('parses post mode and explicit overrides', () => {
    const options = __private.parseArgs([
      '--repo',
      'proompteng/lab',
      '--limit',
      '25',
      '--output-dir',
      'docs/custom-workflows',
      '--post',
      '--synthetic-issue-number',
      '900000001',
      '--base-url',
      'http://localhost:8181',
      '--auth-token',
      'secret',
    ])

    expect(options.repo).toBe('proompteng/lab')
    expect(options.limit).toBe(25)
    expect(options.outputDir).toBe('docs/custom-workflows')
    expect(options.post).toBeTrue()
    expect(options.syntheticIssueNumber).toBe(900000001)
    expect(options.baseUrl).toBe('http://localhost:8181')
    expect(options.authToken).toBe('secret')
  })

  it('selects a single generated payload by synthetic issue number', () => {
    const outputDir = '/tmp/replay-workflows'
    const records = [
      {
        number: 3610,
        title: 'Analyze whitepaper: arXiv 2510.27251',
        body: '',
        url: 'https://github.com/proompteng/lab/issues/3610',
        closedAt: '2026-02-24T17:06:47Z',
        attachmentUrl: 'https://arxiv.org/pdf/2510.27251.pdf',
        paperTitle: 'FinPos: A Position-Aware Trading Agent System for Real Financial Markets',
      },
      {
        number: 3592,
        title: 'Analyze whitepaper: arXiv 2505.11122',
        body: '',
        url: 'https://github.com/proompteng/lab/issues/3592',
        closedAt: '2026-02-24T10:00:00Z',
        attachmentUrl: 'https://arxiv.org/pdf/2505.11122.pdf',
        paperTitle: 'The Impact of Option Demand Shocks on Underlying Stock Prices',
      },
    ]

    const generated = __private.buildManifest('proompteng/lab', records, outputDir)
    const selected = __private.selectPayloads(generated.manifest, generated.payloads, 900000002)

    expect(selected.manifest.uniqueWhitepaperCount).toBe(1)
    expect(selected.manifest.items[0]?.syntheticIssueNumber).toBe(900000002)
    expect(selected.payloads).toHaveLength(1)
    expect(selected.payloads[0]?.payload.issue.number).toBe(900000002)
  })
})
