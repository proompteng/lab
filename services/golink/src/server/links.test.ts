import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeTestDb, createTestDb } from '../db/client'
import { createLink, deleteLink, findById, findBySlug, listLinks, updateLink } from './links'

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
    expect(typeof duplicate.message === 'string' && duplicate.message.length > 0).toBe(true)
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

  test('normalizes optional fields on create and update', async () => {
    const created = await createLink(db, {
      slug: 'normalize',
      targetUrl: 'https://normalize.example',
      title: '  Trim me  ',
      notes: '   ',
    })
    if (!created.ok) throw new Error('failed to create link')

    expect(created.link.title).toBe('Trim me')
    expect(created.link.notes).toBeNull()

    const updated = await updateLink(db, { id: created.link.id, notes: '  keeps text  ' })
    if (!updated.ok) throw new Error('failed to update link')

    expect(updated.link.notes).toBe('keeps text')
  })

  test('deletes a link', async () => {
    const created = await createLink(db, { slug: 'remove', targetUrl: 'https://gone', title: 'Gone' })
    if (!created.ok) throw new Error('failed to seed')

    const result = await deleteLink(db, created.link.id)
    expect(result.ok).toBe(true)

    const missing = await findBySlug(db, 'remove')
    expect(missing).toBeNull()
  })

  test('finds a specific link by id', async () => {
    const created = await createLink(db, {
      slug: 'lookup',
      targetUrl: 'https://lookup.example',
      title: 'Lookup',
    })
    if (!created.ok) throw new Error('failed to seed lookup')

    const found = await findById(db, created.link.id)
    expect(found?.slug).toBe('lookup')
    expect(found?.targetUrl).toBe('https://lookup.example')
  })

  test('handles missing records on update and delete', async () => {
    const missingUpdate = await updateLink(db, { id: 9999, title: 'Nope' })
    expect(missingUpdate).toEqual({ ok: false, message: 'Link not found' })

    const missingDelete = await deleteLink(db, 9999)
    expect(missingDelete).toEqual({ ok: false, message: 'Link not found' })
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

  test('search matches across notes and targets', async () => {
    await createLink(db, {
      slug: 'notes-match',
      targetUrl: 'https://example.com/docs',
      title: 'Docs',
      notes: 'internal wiki',
    })
    await createLink(db, { slug: 'target-match', targetUrl: 'https://intranet.example.com', title: 'Intranet' })

    const byNotes = await listLinks(db, { search: 'wiki' })
    expect(byNotes.map((link) => link.slug)).toEqual(['notes-match'])

    const byTarget = await listLinks(db, { search: 'intranet' })
    expect(byTarget.map((link) => link.slug)).toEqual(['target-match'])
  })
})

afterEach(async () => {
  await closeTestDb(client)
})
