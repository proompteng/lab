import { describe, expect, it } from 'bun:test'

import { __private, computeDeleteManifestPlan, parseArgs, selectPrunePlan } from '../prune-images'

describe('registry prune-images', () => {
  it('paginates /tags/list responses using the Link header', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
      calls.push(url.toString())

      if (!url.pathname.endsWith('/tags/list')) {
        return new Response('not found', { status: 404 })
      }

      const last = url.searchParams.get('last')
      if (!last) {
        return new Response(JSON.stringify({ name: 'lab/jangar', tags: ['a', 'b'] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<http://example/v2/lab/jangar/tags/list?n=1000&last=b>; rel="next"',
          },
        })
      }

      if (last === 'b') {
        return new Response(JSON.stringify({ name: 'lab/jangar', tags: ['c'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ name: 'lab/jangar', tags: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const tags = await __private.listTags('http://example', 'lab/jangar')
      expect(tags).toEqual(['a', 'b', 'c'])
      expect(calls.length).toBe(2)
      expect(calls[0]).toContain('n=1000')
      expect(calls[0]).not.toContain('last=')
      expect(calls[1]).toContain('last=b')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps last N version-like tags and skips non-version tags by default', () => {
    const tags = [
      { tag: 'latest', manifestDigest: 'sha256:latest', createdAtMs: 50 },
      { tag: 'aaa1111', manifestDigest: 'sha256:a', createdAtMs: 10 },
      { tag: 'bbb2222', manifestDigest: 'sha256:b', createdAtMs: 20 },
      { tag: 'ccc3333', manifestDigest: 'sha256:c', createdAtMs: 30 },
      { tag: 'notes', manifestDigest: 'sha256:notes', createdAtMs: 40 },
    ]

    const plan = selectPrunePlan(
      {
        keep: 2,
        keepTags: ['latest'],
        tagPattern: /^[a-z]{3}\d{4}$/,
        unsafeAllTags: false,
      },
      tags,
    )

    expect(plan.keep.map((t) => t.tag)).toEqual(['ccc3333', 'bbb2222'])
    expect(plan.delete.map((t) => t.tag)).toEqual(['aaa1111'])
    expect(plan.skipped).toContainEqual({ reason: 'protected-tag', tag: 'latest' })
    expect(plan.skipped).toContainEqual({ reason: 'non-version-tag', tag: 'notes' })
  })

  it('does not delete manifests referenced by protected tags', () => {
    const tags = [
      { tag: 'latest', manifestDigest: 'sha256:shared', createdAtMs: 50 },
      { tag: 'aaa1111', manifestDigest: 'sha256:shared', createdAtMs: 10 },
      { tag: 'bbb2222', manifestDigest: 'sha256:bbb', createdAtMs: 20 },
      { tag: 'ccc3333', manifestDigest: 'sha256:ccc', createdAtMs: 30 },
    ]

    const plan = selectPrunePlan(
      {
        keep: 1,
        keepTags: ['latest'],
        tagPattern: /^[a-z]{3}\d{4}$/,
        unsafeAllTags: false,
      },
      tags,
    )

    const manifestPlan = computeDeleteManifestPlan(plan, tags)
    expect(manifestPlan.skippedByProtectedDigest).toContainEqual({ tag: 'aaa1111', manifestDigest: 'sha256:shared' })
    expect(manifestPlan.deleteManifests.map((entry) => entry.manifestDigest)).toEqual(['sha256:bbb'])
  })

  it('can prune all tags when --unsafe-all-tags is enabled', () => {
    const tags = [
      { tag: 'latest', manifestDigest: 'sha256:latest', createdAtMs: 50 },
      { tag: 'prod', manifestDigest: 'sha256:prod', createdAtMs: 40 },
      { tag: 'aaa1111', manifestDigest: 'sha256:a', createdAtMs: 10 },
      { tag: 'bbb2222', manifestDigest: 'sha256:b', createdAtMs: 20 },
      { tag: 'ccc3333', manifestDigest: 'sha256:c', createdAtMs: 30 },
    ]

    const plan = selectPrunePlan(
      {
        keep: 2,
        keepTags: [],
        tagPattern: /^[a-z]{3}\d{4}$/,
        unsafeAllTags: true,
      },
      tags,
    )

    expect(plan.keep.map((t) => t.tag)).toEqual(['latest', 'prod'])
    expect(plan.delete.map((t) => t.tag)).toEqual(['ccc3333', 'bbb2222', 'aaa1111'])
    expect(plan.skipped).toEqual([])
  })

  it('parseArgs accepts repeated --repo and --keep-tag', () => {
    const options = parseArgs([
      '--repo=lab/jangar',
      '--repo=lab/facteur',
      '--keep=7',
      '--keep-tag=main',
      '--keep-tag=latest',
      '--concurrency=3',
      '--gc',
      '--no-restart-registry',
      '--apply',
      '--tag-pattern=^v[0-9]+$',
      '--catalog-page-size=123',
      '--port=5555',
      '--namespace=registry',
      '--unsafe-all-tags',
    ])

    expect(options.apply).toBe(true)
    expect(options.gc).toBe(true)
    expect(options.restartRegistry).toBe(false)
    expect(options.keep).toBe(7)
    expect(options.concurrency).toBe(3)
    expect(options.catalogPageSize).toBe(123)
    expect(options.portForwardPort).toBe(5555)
    expect(options.namespace).toBe('registry')
    expect(options.repositories.sort()).toEqual(['lab/facteur', 'lab/jangar'])
    expect(options.keepTags.includes('latest')).toBe(true)
    expect(options.keepTags.includes('main')).toBe(true)
    expect(options.tagPattern.test('v12')).toBe(true)
    expect(options.unsafeAllTags).toBe(true)
  })
})
