import { wikiSources } from '@/src/data/olden/sources'

type SourceNoteProps = {
  ids: string[]
}

export const sourceNoteClassNames = {
  aside: 'not-prose rounded-lg border border-fd-border bg-fd-card p-3 text-sm text-fd-muted-foreground',
  title: 'mb-2 text-xs font-semibold text-fd-foreground',
  list: 'space-y-1.5',
  link: 'font-medium text-fd-foreground underline decoration-fd-muted-foreground underline-offset-2 transition hover:text-fd-primary hover:decoration-fd-primary',
  meta: 'text-fd-muted-foreground',
} as const

export function SourceNote({ ids }: SourceNoteProps) {
  const sources = wikiSources.filter((source) => ids.includes(source.id))

  return (
    <aside className={sourceNoteClassNames.aside} aria-label="Sources">
      <p className={sourceNoteClassNames.title}>Sources</p>
      <ul className={sourceNoteClassNames.list}>
        {sources.map((source) => (
          <li key={source.id}>
            <a className={sourceNoteClassNames.link} href={source.url}>
              {source.title}
            </a>
            <span className={sourceNoteClassNames.meta}> - retrieved {source.retrievedAt}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
