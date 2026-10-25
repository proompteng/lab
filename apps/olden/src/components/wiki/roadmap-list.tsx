import { roadmapItems } from '@/src/data/olden/roadmap'

const horizonLabel = {
  'near-term': 'Near term',
  'early-access': 'Early Access',
  'long-term': 'Long term',
}

export function RoadmapList() {
  return (
    <div className="not-prose space-y-3">
      {roadmapItems.map((item) => (
        <section key={item.name} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{item.name}</h2>
            <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
              {horizonLabel[item.horizon]}
            </span>
          </div>
          <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{item.playerImpact}</p>
        </section>
      ))}
    </div>
  )
}
