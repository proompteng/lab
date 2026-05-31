import { artifactSetEntries } from '@/src/data/olden/assets'

const visibleEffects = (effects: string[]) =>
  effects.length > 0 ? effects : ['Source set bonus listed without detail.']

export function ArtifactSetReference() {
  return (
    <div className="not-prose space-y-4">
      <div className="rounded-lg border border-fd-border bg-fd-card p-4">
        <p className="text-sm font-semibold text-fd-foreground">Artifact set combinations</p>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          {artifactSetEntries.length} public set rows are indexed with source icons, item composition, threshold
          effects, and practical build-plan labels. Set bonuses stack when later thresholds are completed.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {artifactSetEntries.map((set) => (
          <section key={set.id} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <div className="grid gap-4 sm:grid-cols-[80px_1fr]">
              <a
                className="flex h-20 w-20 items-center justify-center rounded border border-fd-border bg-fd-muted p-2"
                href={set.url}
              >
                <img
                  className="max-h-16 max-w-16 object-contain"
                  src={set.image}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              </a>
              <div>
                <h3 className="text-base font-semibold text-fd-foreground">{set.name}</h3>
                <p className="mt-1 text-sm text-fd-muted-foreground">{set.playPattern}</p>
                <a
                  className="mt-2 inline-block text-xs font-semibold text-fd-foreground underline decoration-fd-muted-foreground/60 underline-offset-2"
                  href={set.url}
                >
                  Source set page
                </a>
              </div>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.15fr]">
              <div>
                <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Threshold effects</p>
                <ul className="mt-2 space-y-2 text-sm text-fd-foreground">
                  {visibleEffects(set.effects).map((effect) => (
                    <li key={effect} className="rounded border border-fd-border bg-fd-muted/30 px-3 py-2">
                      {effect}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-fd-muted-foreground">Items ({set.items.length})</p>
                <div className="mt-2 grid gap-2">
                  {set.items.map((item) => (
                    <a
                      key={`${set.id}-${item.name}`}
                      className="grid grid-cols-[42px_1fr] gap-3 rounded border border-fd-border bg-fd-muted/30 p-2 text-sm transition hover:border-fd-primary/50"
                      href={item.url}
                    >
                      {item.image ? (
                        <img
                          className="h-10 w-10 object-contain"
                          src={item.image}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="h-10 w-10 rounded bg-fd-muted" />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fd-foreground">{item.name}</span>
                        <span className="text-xs text-fd-muted-foreground">
                          {[item.slot, item.rarity].filter(Boolean).join(' / ')}
                        </span>
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
