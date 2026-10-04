import Link from 'next/link'

import { factions } from '@/src/data/olden/factions'
import { FreshnessBadge } from './freshness-badge'

export function FactionGrid() {
  return (
    <div className="olden-lg-grid-cols-3 not-prose grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {factions.map((faction) => (
        <Link
          key={faction.id}
          className="rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
          href={`/docs/factions/${faction.id}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{faction.name}</h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{faction.nativeTerrain}</p>
            </div>
            <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium capitalize text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {faction.beginnerFit}
            </span>
          </div>
          <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{faction.identity}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {faction.playstyleTags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="mt-4">
            <FreshnessBadge {...faction.verification} />
          </div>
        </Link>
      ))}
    </div>
  )
}
