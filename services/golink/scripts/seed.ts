import { eq } from 'drizzle-orm'
import { getDb } from '../src/db/client'
import { links } from '../src/db/schema/links'
import { linkInputSchema } from '../src/server/links'

const seedLinks = [
  {
    slug: 'status',
    targetUrl: 'https://status.proompteng.ai',
    title: 'Status Page',
    notes: 'Public incident feed',
  },
  {
    slug: 'handoff',
    targetUrl: 'https://proompteng.notion.site/ops-handoff',
    title: 'Ops Handoff Template',
    notes: 'Daily rollups',
  },
]

const main = async () => {
  const db = getDb()
  for (const candidate of seedLinks) {
    const parsed = linkInputSchema.parse(candidate)
    const [existing] = await db.select().from(links).where(eq(links.slug, parsed.slug)).limit(1)
    if (!existing) {
      await db.insert(links).values(parsed)
      console.log(`Inserted seed link ${parsed.slug}`)
    }
  }
  process.exit(0)
}

main().catch((error) => {
  console.error('Failed to seed golink', error)
  process.exit(1)
})
