import { BookOpen, Castle, Map, ScrollText, Shield, Swords } from 'lucide-react'
import Link from 'next/link'

const entryPoints = [
  {
    title: 'Start Playing',
    description: 'First-week route, town priorities, combat basics, and the mistakes that cost new players games.',
    href: '/docs/getting-started',
    icon: BookOpen,
  },
  {
    title: 'Factions',
    description: 'Temple, Necropolis, Grove, Dungeon, Hive, and Schism with strengths, counters, and first-week plans.',
    href: '/docs/factions',
    icon: Castle,
  },
  {
    title: 'Combat',
    description: 'Initiative, retaliation, blocking, ranged pressure, spell timing, army preservation, and sieges.',
    href: '/docs/fundamentals/combat',
    icon: Swords,
  },
  {
    title: 'Map Economy',
    description: 'Mines, roads, dwellings, routes, scouting, town development, and movement tempo.',
    href: '/docs/fundamentals/adventure-map',
    icon: Map,
  },
  {
    title: 'Reference',
    description: 'Heroes, units, spells, skills, laws, artifacts, buildings, and map objects by gameplay use.',
    href: '/docs/reference',
    icon: ScrollText,
  },
  {
    title: 'Strategy',
    description: 'Creeping, build orders, hero development, faction counters, PvP basics, and recovery plans.',
    href: '/docs/strategy',
    icon: Shield,
  },
]

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-b border-zinc-200 bg-zinc-950 text-zinc-50 dark:border-zinc-800">
        <div className="mx-auto grid min-h-[68vh] w-full max-w-6xl items-center gap-10 px-6 py-16 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:px-12">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <h1 className="max-w-3xl text-balance text-4xl font-semibold sm:text-5xl lg:text-6xl">Olden Era Wiki</h1>
              <p className="max-w-2xl text-base leading-7 text-zinc-300 sm:text-lg">
                An unofficial player wiki for Heroes of Might and Magic: Olden Era, focused on the practical knowledge
                needed to route the map, build towns, preserve armies, and understand every faction.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                className="inline-flex items-center rounded-md bg-zinc-50 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
                href="/docs/getting-started"
              >
                Start with the first week
              </Link>
              <Link
                className="inline-flex items-center rounded-md border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-zinc-500"
                href="/docs/factions"
              >
                Compare factions
              </Link>
            </div>
          </div>
          <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              {['Temple', 'Grove', 'Dungeon', 'Necropolis', 'Hive', 'Schism'].map((name) => (
                <Link
                  key={name}
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-4 text-sm font-medium text-zinc-100 transition hover:border-zinc-600"
                  href={`/docs/factions/${name.toLowerCase()}`}
                >
                  {name}
                </Link>
              ))}
            </div>
            <div className="grid gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
              <div className="flex items-center justify-between gap-4">
                <span>Current baseline</span>
                <span className="font-medium text-zinc-50">v0.80.16</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Game state</span>
                <span className="font-medium text-zinc-50">Early Access</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span>Last verified</span>
                <span className="font-medium text-zinc-50">2026-05-31</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto grid w-full max-w-6xl gap-4 px-6 py-12 sm:px-8 md:grid-cols-2 lg:grid-cols-3 lg:px-12">
        {entryPoints.map((item) => (
          <Link
            key={item.href}
            className="rounded-lg border border-zinc-200 p-5 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
            href={item.href}
          >
            <item.icon className="h-5 w-5 text-zinc-700 dark:text-zinc-300" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold text-zinc-950 dark:text-zinc-50">{item.title}</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{item.description}</p>
          </Link>
        ))}
      </section>
    </main>
  )
}
