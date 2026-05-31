import { wikiSources } from '@/src/data/olden/sources'

type SourceNoteProps = {
  ids: string[]
}

export const sourceNoteClassNames = {
  aside: 'not-prose rounded-lg border border-fd-border bg-fd-card p-4 text-sm text-fd-muted-foreground shadow-sm',
  title: 'text-sm font-semibold text-fd-foreground',
  list: 'mt-2 space-y-2',
  link: 'font-medium text-fd-foreground underline decoration-fd-muted-foreground underline-offset-2 transition hover:text-fd-primary hover:decoration-fd-primary',
  meta: 'text-fd-muted-foreground',
} as const

export function SourceNote({ ids }: SourceNoteProps) {
  const sources = wikiSources.filter((source) => ids.includes(source.id))

  return (
    <aside className={sourceNoteClassNames.aside}>
      <h2 className={sourceNoteClassNames.title}>Sources</h2>
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
