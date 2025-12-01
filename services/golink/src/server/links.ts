import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq, ilike, or } from 'drizzle-orm'
import { z } from 'zod'
import { type Database, getDb, type TestDatabase } from '../db/client'
import { type Link, links } from '../db/schema/links'

const slugSchema = z
  .string()
  .trim()
  .min(1, 'Slug is required')
  .max(120, 'Keep slugs under 120 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-_/]*$/, 'Only letters, numbers, dashes, underscores, and slashes are allowed')
const linkIdSchema = z.number().int().positive()
const urlSchema = z.string().url('Target must be a valid URL').max(2048)
const titleSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().max(200, 'Keep titles under 200 characters').optional())
const notesSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .or(z.literal('').transform(() => undefined))

export const linkInputSchema = z.object({
  slug: slugSchema,
  targetUrl: urlSchema,
  title: titleSchema,
  notes: notesSchema,
})

export const linkUpdateSchema = linkInputSchema.partial().extend({
  id: z.number().int().positive(),
})

export const deleteLinkSchema = z.object({ id: z.number().int().positive() })

export const listFiltersSchema = z
  .object({
    search: z.string().trim().optional(),
    sort: z.enum(['createdAt', 'slug', 'title']).default('createdAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .partial()
  .optional()

export type LinkFilters = z.infer<typeof listFiltersSchema>
export type LinkInput = z.infer<typeof linkInputSchema>
export type LinkUpdateInput = z.infer<typeof linkUpdateSchema>

const sortColumn = (sort?: string) => {
  switch (sort) {
    case 'slug':
      return links.slug
    case 'title':
      return links.title
    default:
      return links.createdAt
  }
}

const toOrderBy = (sort?: string, direction?: 'asc' | 'desc') => {
  const column = sortColumn(sort)
  return direction === 'asc' ? asc(column) : desc(column)
}

const mapError = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505') {
    return 'Slug already exists. Pick something unique.'
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: string }).message ?? '')
    if (message.toLowerCase().includes('duplicate')) {
      return 'Slug already exists. Pick something unique.'
    }
  }
  return 'Unable to save changes right now. Please try again.'
}

type DbClient = Database | TestDatabase

export const listLinks = async (db: DbClient, filters?: LinkFilters) => {
  const { search, sort, direction } = filters ?? {}
  const baseQuery = db.select().from(links)

  const filteredQuery = (() => {
    if (search && search.trim().length > 0) {
      const term = `%${search.trim()}%`
      return baseQuery.where(
        or(ilike(links.slug, term), ilike(links.title, term), ilike(links.targetUrl, term), ilike(links.notes, term)),
      )
    }
    return baseQuery
  })()

  return filteredQuery.orderBy(toOrderBy(sort, direction))
}

const normalizeOptional = (value?: string) => {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export const createLink = async (db: DbClient, input: LinkInput) => {
  const values = {
    ...input,
    title: normalizeOptional(input.title),
    notes: normalizeOptional(input.notes),
  }
  try {
    const [record] = await db.insert(links).values(values).returning()
    return { ok: true as const, link: record }
  } catch (error) {
    return { ok: false as const, message: mapError(error) }
  }
}

export const updateLink = async (db: DbClient, input: LinkUpdateInput) => {
  const { id, ...rest } = input
  try {
    const [record] = await db
      .update(links)
      .set({
        ...rest,
        title: normalizeOptional(rest.title),
        notes: normalizeOptional(rest.notes),
        updatedAt: new Date(),
      })
      .where(eq(links.id, id))
      .returning()
    if (!record) {
      return { ok: false as const, message: 'Link not found' }
    }
    return { ok: true as const, link: record }
  } catch (error) {
    return { ok: false as const, message: mapError(error) }
  }
}

export const findById = async (db: DbClient, id: number) => {
  const [record] = await db.select().from(links).where(eq(links.id, id)).limit(1)
  return record ?? null
}

export const deleteLink = async (db: DbClient, id: number) => {
  const [record] = await db.delete(links).where(eq(links.id, id)).returning()
  if (!record) {
    return { ok: false as const, message: 'Link not found' }
  }
  return { ok: true as const, link: record }
}

export const findBySlug = async (db: DbClient, slug: string) => {
  const [record] = await db.select().from(links).where(eq(links.slug, slug)).limit(1)
  return record ?? null
}

const listLinksServer = createServerFn({ method: 'GET' })
  .inputValidator((input) => listFiltersSchema.parse(input ?? {}))
  .handler(async ({ data }) => listLinks(getDb(), data ?? undefined))

const createLinkServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => linkInputSchema.parse(input))
  .handler(async ({ data }) => createLink(getDb(), data))

const updateLinkServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => linkUpdateSchema.parse(input))
  .handler(async ({ data }) => updateLink(getDb(), data))

const deleteLinkServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => deleteLinkSchema.parse(input))
  .handler(async ({ data }) => deleteLink(getDb(), data.id))

const resolveIdServer = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ id: linkIdSchema }).parse(input))
  .handler(async ({ data }) => findById(getDb(), data.id))

const resolveSlugServer = createServerFn({ method: 'GET' })
  .inputValidator((input) => z.object({ slug: slugSchema }).parse(input))
  .handler(async ({ data }) => findBySlug(getDb(), data.slug))

export const serverFns = {
  listLinks: listLinksServer,
  createLink: createLinkServer,
  updateLink: updateLinkServer,
  deleteLink: deleteLinkServer,
  getLinkById: resolveIdServer,
  resolveSlug: resolveSlugServer,
}

export type ServerFns = typeof serverFns

export type LinkActionResult = { ok: true; link: Link } | { ok: false; message: string }
