import { gameModes } from '@/src/data/olden/game-modes'

export function GameModeList() {
  return (
    <div className="olden-lg-grid-cols-2 not-prose grid gap-4 lg:grid-cols-2">
      {gameModes.map((mode) => (
        <section key={mode.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">{mode.name}</h2>
          <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{mode.playerPromise}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-500">Good for</h3>
              <ul className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
                {mode.goodFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase text-zinc-500 dark:text-zinc-500">Watch for</h3>
              <ul className="mt-2 space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
                {mode.watchOutFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}
