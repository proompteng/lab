import { describe, expect, it } from 'bun:test'

import { parseArgs, selectPrunePlan } from '../prune-images'

describe('registry prune-images', () => {
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
      '--no-gc',
      '--apply',
      '--tag-pattern=^v[0-9]+$',
      '--catalog-page-size=123',
      '--port=5555',
      '--namespace=registry',
      '--unsafe-all-tags',
    ])

    expect(options.apply).toBe(true)
    expect(options.gc).toBe(false)
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
