import { Badge, Button, Input, ScrollArea, Tooltip, TooltipContent, TooltipTrigger } from '@proompteng/design/ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Filter,
  MessageCircle,
  RefreshCw,
  Search,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FeedResponse, SynthesisItem } from '~/server/schema'

export const Route = createFileRoute('/')({
  component: App,
})

const defaultTags = ['semis', 'devtools', 'ai agents', 'quant', 'options', 'ml', 'trading systems']

const formatDate = (value: string | null) => {
  if (!value) return 'unknown'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

const statusIcon = (status: SynthesisItem['engagementStatus']) => {
  if (status === 'queued') return <Clock3 className="size-3.5" />
  if (status === 'sent') return <CheckCircle2 className="size-3.5" />
  if (status === 'failed') return <X className="size-3.5" />
  return <Filter className="size-3.5" />
}

async function fetchFeed(tag: string, minScore: number): Promise<FeedResponse> {
  const params = new URLSearchParams({ limit: '60', minScore: String(minScore) })
  if (tag !== 'all') params.set('tag', tag)
  const response = await fetch(`/api/feed?${params.toString()}`)
  if (!response.ok) throw new Error(`feed request failed: ${response.status}`)
  return (await response.json()) as FeedResponse
}

function App() {
  const [tag, setTag] = useState('all')
  const [query, setQuery] = useState('')
  const [minScore, setMinScore] = useState(0.65)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const feed = useQuery({
    queryKey: ['synthesis-feed', tag, minScore],
    queryFn: () => fetchFeed(tag, minScore),
    refetchInterval: 45_000,
  })

  const items = useMemo(() => {
    const lowered = query.trim().toLowerCase()
    const base = feed.data?.items ?? []
    if (!lowered) return base
    return base.filter((item) =>
      [item.summary, item.whyValuable, item.observedText, item.authorHandle, item.topicTags.join(' ')]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(lowered)),
    )
  }, [feed.data?.items, query])

  const selectedItem = items.find((item) => item.id === selectedId) ?? items[0] ?? null

  return (
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-neutral-950 text-neutral-100 lg:grid-cols-[minmax(0,1fr)_420px]">
      <section className="flex min-w-0 flex-col border-r border-neutral-800/80">
        <header className="flex min-h-[72px] flex-wrap items-center gap-3 border-b border-neutral-800/80 px-4 py-3 md:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              synthesis
            </div>
            <h1 className="mt-1 truncate text-xl font-semibold text-neutral-50">x feed intelligence</h1>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="outline" onClick={() => feed.refetch()} aria-label="Refresh feed">
                <RefreshCw className={`size-4 ${feed.isFetching ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh feed</TooltipContent>
          </Tooltip>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800/80 px-4 py-3 md:px-6">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="filter summaries"
              className="h-9 border-neutral-800 bg-neutral-900/70 pl-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase text-neutral-500">score</span>
            <input
              aria-label="Minimum score"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={minScore}
              onChange={(event) => setMinScore(Number(event.target.value))}
              className="h-2 w-28 accent-cyan-400"
            />
            <span className="w-9 text-right text-xs text-neutral-300">{minScore.toFixed(2)}</span>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto border-b border-neutral-800/80 px-4 py-2 md:px-6">
          {['all', ...defaultTags].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tag === value ? 'default' : 'outline'}
              className="h-8 shrink-0 rounded-sm px-3 text-xs"
              onClick={() => setTag(value)}
            >
              {value}
            </Button>
          ))}
        </div>

        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
          <div className="grid gap-3 px-4 py-4 md:px-6">
            {feed.isLoading ? (
              Array.from({ length: 7 }, (_, index) => (
                <div key={index} className="h-[154px] rounded-sm border border-neutral-800 bg-neutral-900/40 p-4">
                  <div className="mb-4 h-4 w-1/3 rounded bg-neutral-800 animate-pulse" />
                  <div className="mb-2 h-4 w-full rounded bg-neutral-800 animate-pulse" />
                  <div className="mb-4 h-4 w-5/6 rounded bg-neutral-800 animate-pulse" />
                  <div className="flex gap-2">
                    <div className="h-6 w-20 rounded bg-neutral-800 animate-pulse" />
                    <div className="h-6 w-24 rounded bg-neutral-800 animate-pulse" />
                  </div>
                </div>
              ))
            ) : feed.error ? (
              <div
                role="alert"
                className="rounded-sm border border-rose-900/70 bg-rose-950/30 p-4 text-sm text-rose-200"
              >
                {feed.error instanceof Error ? feed.error.message : 'feed unavailable'}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-sm border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-300">
                no synthesis items match the current filters.
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id)
                    setMobileDetailOpen(true)
                  }}
                  className={`group min-h-[154px] rounded-sm border p-4 text-left transition-colors ${
                    selectedItem?.id === item.id
                      ? 'border-cyan-500/70 bg-cyan-950/15'
                      : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900/70'
                  }`}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                        <span className="truncate">{item.authorHandle ? `@${item.authorHandle}` : 'x.com'}</span>
                        <span>{formatDate(item.observedAt)}</span>
                      </div>
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-neutral-100">{item.summary}</p>
                    </div>
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-neutral-800 bg-neutral-950 text-sm font-semibold text-cyan-300">
                      {Math.round(item.score * 100)}
                    </div>
                  </div>
                  {item.whyValuable ? (
                    <p className="mb-3 line-clamp-2 text-xs leading-5 text-neutral-400">{item.whyValuable}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {item.topicTags.slice(0, 5).map((topic) => (
                      <Badge
                        key={topic}
                        variant="secondary"
                        className="rounded-sm border-neutral-700 bg-neutral-800/80"
                      >
                        {topic}
                      </Badge>
                    ))}
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-neutral-500">
                      {statusIcon(item.engagementStatus)}
                      {item.engagementStatus}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </section>

      <aside className="hidden min-h-0 flex-col bg-neutral-950 lg:flex">
        {selectedItem ? <DetailPane item={selectedItem} /> : null}
      </aside>

      {mobileDetailOpen && selectedItem ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950 lg:hidden">
          <DetailPane item={selectedItem} onClose={() => setMobileDetailOpen(false)} />
        </div>
      ) : null}
    </main>
  )
}

function DetailPane({ item, onClose }: { item: SynthesisItem; onClose?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-neutral-800/80 px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm text-neutral-400">{item.authorHandle ? `@${item.authorHandle}` : 'x.com'}</p>
            <h2 className="mt-1 text-lg font-semibold text-neutral-50">detail</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild size="icon" variant="outline" aria-label="Open original post">
              <a href={item.originalUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
              </a>
            </Button>
            {onClose ? (
              <Button size="icon" variant="outline" onClick={onClose} aria-label="Close detail">
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Metric label="score" value={item.score.toFixed(2)} />
          <Metric label="confidence" value={item.confidence.toFixed(2)} />
          <Metric label="engagement" value={item.engagementStatus} />
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-y-auto">
        <div className="grid gap-5 px-5 py-5">
          <section>
            <h3 className="mb-2 text-xs uppercase text-neutral-500">summary</h3>
            <p className="text-sm leading-6 text-neutral-100">{item.summary}</p>
          </section>
          {item.whyValuable ? (
            <section>
              <h3 className="mb-2 text-xs uppercase text-neutral-500">why it matters</h3>
              <p className="text-sm leading-6 text-neutral-200">{item.whyValuable}</p>
            </section>
          ) : null}
          {item.evidence.length ? (
            <section>
              <h3 className="mb-2 text-xs uppercase text-neutral-500">evidence</h3>
              <ul className="grid gap-2">
                {item.evidence.map((line) => (
                  <li
                    key={line}
                    className="rounded-sm border border-neutral-800 bg-neutral-900/50 p-3 text-xs leading-5"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="mb-2 text-xs uppercase text-neutral-500">observed post</h3>
            <p className="whitespace-pre-wrap rounded-sm border border-neutral-800 bg-neutral-900/50 p-3 text-xs leading-5 text-neutral-300">
              {item.observedText}
            </p>
          </section>
          <section>
            <h3 className="mb-2 text-xs uppercase text-neutral-500">actions</h3>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="gap-1 rounded-sm border-neutral-700">
                <ThumbsUp className="size-3.5" />
                {item.engagementRecommendation}
              </Badge>
              {item.replyText ? (
                <Badge variant="outline" className="gap-1 rounded-sm border-neutral-700">
                  <MessageCircle className="size-3.5" />
                  {item.replyText}
                </Badge>
              ) : null}
              <Button asChild size="sm" variant="secondary" className="h-7 rounded-sm px-2 text-xs">
                <a href={item.originalUrl} target="_blank" rel="noreferrer">
                  <ArrowUpRight className="mr-1 size-3.5" />
                  original
                </a>
              </Button>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-neutral-800 bg-neutral-900/60 px-3 py-2">
      <div className="text-[10px] uppercase text-neutral-500">{label}</div>
      <div className="mt-1 truncate text-xs text-neutral-100">{value}</div>
    </div>
  )
}
