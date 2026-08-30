import type { CSSProperties } from 'react'

import { wikiSources } from '@/src/data/olden/sources'

type SourceNoteProps = {
  ids: string[]
}

export const sourceNoteClassNames = {
  aside:
    'not-prose my-6 overflow-x-auto rounded-md border px-3 py-2 text-xs leading-6 whitespace-nowrap text-zinc-400 shadow-sm',
  label: 'mr-2 font-medium text-zinc-200',
  list: 'm-0 inline list-none p-0 whitespace-nowrap',
  item: 'inline whitespace-nowrap',
  link: 'font-medium text-zinc-100 underline decoration-zinc-500 underline-offset-2 transition hover:text-white hover:decoration-zinc-200',
  meta: 'text-zinc-500',
  separator: 'mx-2 text-zinc-700',
} as const

export const sourceNoteStyles = {
  backgroundColor: '#09090b',
  borderColor: '#27272a',
} satisfies CSSProperties

export const sourceNoteListStyles = {
  display: 'inline',
  listStyle: 'none',
  margin: 0,
  padding: 0,
  whiteSpace: 'nowrap',
} satisfies CSSProperties

export const sourceNoteItemStyles = {
  display: 'inline',
  whiteSpace: 'nowrap',
} satisfies CSSProperties

export function SourceNote({ ids }: SourceNoteProps) {
  const sources = wikiSources.filter((source) => ids.includes(source.id))

  return (
    <aside className={sourceNoteClassNames.aside} style={sourceNoteStyles} aria-label="Sources">
      <span className={sourceNoteClassNames.label}>Sources:</span>
      <ul className={sourceNoteClassNames.list} style={sourceNoteListStyles}>
        {sources.map((source, index) => (
          <li key={source.id} className={sourceNoteClassNames.item} style={sourceNoteItemStyles}>
            <a className={sourceNoteClassNames.link} href={source.url}>
              {source.title}
            </a>
            <span className={sourceNoteClassNames.meta}> - retrieved {source.retrievedAt}</span>
            {index < sources.length - 1 ? <span className={sourceNoteClassNames.separator}>/</span> : null}
          </li>
        ))}
      </ul>
    </aside>
  )
}
