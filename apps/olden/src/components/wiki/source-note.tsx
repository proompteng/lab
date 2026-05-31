import { wikiSources } from '@/src/data/olden/sources'

type SourceNoteProps = {
  ids: string[]
}

export function SourceNote({ ids }: SourceNoteProps) {
  const sources = wikiSources.filter((source) => ids.includes(source.id))

  return (
    <aside className="not-prose rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">Sources</h2>
      <ul className="mt-2 space-y-2">
        {sources.map((source) => (
          <li key={source.id}>
            <a className="font-medium text-zinc-900 underline dark:text-zinc-100" href={source.url}>
              {source.title}
            </a>
            <span className="text-zinc-600 dark:text-zinc-400"> - retrieved {source.retrievedAt}</span>
          </li>
        ))}
      </ul>
    </aside>
  )
}
