import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeTestDb, createTestDb } from '../db/client'
import { createLink, deleteLink, findBySlug, listLinks, updateLink } from './links'

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let client: Awaited<ReturnType<typeof createTestDb>>['client']

beforeEach(async () => {
  const setup = await createTestDb()
  db = setup.db
  client = setup.client
})

describe('link service', () => {
  test('creates and reads a link by slug', async () => {
    const createResult = await createLink(db, {
      slug: 'docs',
      targetUrl: 'https://example.com/docs',
      title: 'Docs',
      notes: 'Primary docs',
    })
    expect(createResult.ok).toBe(true)

    const found = await findBySlug(db, 'docs')
    expect(found?.targetUrl).toBe('https://example.com/docs')
  })

  test('rejects duplicate slugs', async () => {
    await createLink(db, { slug: 'repeat', targetUrl: 'https://a', title: 'First' })
    const duplicate = await createLink(db, { slug: 'repeat', targetUrl: 'https://b', title: 'Second' })
    expect(duplicate.ok).toBe(false)
  })

  test('updates a link and keeps slug intact', async () => {
    const created = await createLink(db, { slug: 'edit', targetUrl: 'https://old', title: 'Old' })
    if (!created.ok) throw new Error('failed to seed')

    const updated = await updateLink(db, { id: created.link.id, title: 'New title', targetUrl: 'https://new' })
    expect(updated.ok).toBe(true)
    expect(updated.ok && updated.link.title).toBe('New title')

    const found = await findBySlug(db, 'edit')
    expect(found?.targetUrl).toBe('https://new')
  })

  test('deletes a link', async () => {
    const created = await createLink(db, { slug: 'remove', targetUrl: 'https://gone', title: 'Gone' })
    if (!created.ok) throw new Error('failed to seed')

    const result = await deleteLink(db, created.link.id)
    expect(result.ok).toBe(true)

    const missing = await findBySlug(db, 'remove')
    expect(missing).toBeNull()
  })

  test('lists links with search and ordering', async () => {
    await createLink(db, { slug: 'alpha', targetUrl: 'https://a', title: 'Alpha' })
    await createLink(db, { slug: 'bravo', targetUrl: 'https://b', title: 'Bravo' })
    await createLink(db, { slug: 'charlie', targetUrl: 'https://c', title: 'Charlie' })

    const all = await listLinks(db, { sort: 'slug', direction: 'asc' })
    expect(all.map((l) => l.slug)).toEqual(['alpha', 'bravo', 'charlie'])

    const filtered = await listLinks(db, { search: 'brav' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.slug).toBe('bravo')
  })
})

afterEach(async () => {
  await closeTestDb(client)
})
