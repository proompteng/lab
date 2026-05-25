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
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import type { FeedResponse, SynthesisItem } from '~/server/schema'

export const Route = createFileRoute('/')({
  component: App,
})

const defaultTags = ['semis', 'devtools', 'ai agents', 'quant', 'options', 'ml', 'trading systems']

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'soft'
type ButtonSize = 'default' | 'sm' | 'icon'

const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'default', className?: string) =>
  cx(
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border text-sm font-medium tracking-normal transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#1f7a6f]/25 disabled:pointer-events-none disabled:opacity-50',
    variant === 'primary' && 'border-[#1f7a6f] bg-[#1f7a6f] text-white hover:bg-[#17665e]',
    variant === 'outline' && 'border-[#d8d2c6] bg-white text-[#201c18] hover:border-[#bfb6a8] hover:bg-[#f8f6f1]',
    variant === 'ghost' && 'border-transparent bg-transparent text-[#625b50] hover:bg-[#eee8dd] hover:text-[#201c18]',
    variant === 'soft' && 'border-[#d9efe9] bg-[#e8f5f1] text-[#17665e] hover:bg-[#d7ede7]',
    size === 'default' && 'h-9 px-3',
    size === 'sm' && 'h-8 px-3 text-xs',
    size === 'icon' && 'size-9',
    className,
  )

function Button({
  className,
  variant = 'primary',
  size = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} {...props} />
}

function AnchorButton({
  className,
  variant = 'primary',
  size = 'default',
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonClass(variant, size, className)} {...props} />
}

function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-10 w-full min-w-0 rounded-md border border-[#d8d2c6] bg-white px-3 text-sm text-[#201c18] outline-none transition-colors placeholder:text-[#8b8378] focus:border-[#1f7a6f] focus:ring-2 focus:ring-[#1f7a6f]/15',
        className,
      )}
      {...props}
    />
  )
}

function Badge({
  className,
  variant = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: 'neutral' | 'teal' | 'amber' | 'rose' }) {
  return (
    <span
      className={cx(
        'inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium',
        variant === 'neutral' && 'border-[#ddd6ca] bg-[#f7f4ee] text-[#5d554b]',
        variant === 'teal' && 'border-[#cfe8e1] bg-[#edf8f4] text-[#17665e]',
        variant === 'amber' && 'border-[#ead8af] bg-[#fff7df] text-[#8a5a09]',
        variant === 'rose' && 'border-[#f0c7c7] bg-[#fff0ef] text-[#9a3412]',
        className,
      )}
      {...props}
    />
  )
}

function ScrollArea({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cx('min-h-0 overflow-y-auto overscroll-contain', className)} {...props}>
      {children}
    </div>
  )
}

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
  if (status === 'queued') return <Clock3 className="size-4" />
  if (status === 'sent') return <CheckCircle2 className="size-4" />
  if (status === 'failed') return <X className="size-4" />
  return <Filter className="size-4" />
}

const statusVariant = (status: SynthesisItem['engagementStatus']) => {
  if (status === 'queued') return 'amber' as const
  if (status === 'failed') return 'rose' as const
  if (status === 'sent') return 'teal' as const
  return 'neutral' as const
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
  const highSignalCount = items.filter((item) => item.score >= 0.85).length
  const queuedCount = items.filter((item) => item.engagementStatus === 'queued').length

  return (
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-[#f4f1ea] text-[#201c18] lg:grid-cols-[280px_minmax(0,1fr)_440px]">
      <aside className="hidden min-h-0 border-r border-[#ddd6ca] bg-[#eee8dd] lg:flex lg:flex-col">
        <div className="px-5 py-5">
          <div className="flex items-center gap-2 text-sm font-medium text-[#5d554b]">
            <span className="size-2 rounded-full bg-[#1f7a6f]" />
            synthesis
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-normal text-[#181512]">Feed synthesis</h1>
          <p className="mt-2 text-sm leading-6 text-[#6f675d]">Signal-dense X posts, condensed for review.</p>
        </div>

        <div className="grid grid-cols-2 gap-2 px-5">
          <RailMetric label="items" value={String(items.length)} />
          <RailMetric label="high signal" value={String(highSignalCount)} />
          <RailMetric label="queued" value={String(queuedCount)} />
          <RailMetric label="score" value={minScore.toFixed(2)} />
        </div>

        <div className="mt-5 border-y border-[#ddd6ca] px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[#7b7368]">minimum score</span>
            <span className="text-sm font-semibold text-[#201c18]">{minScore.toFixed(2)}</span>
          </div>
          <input
            aria-label="Minimum score"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            className="h-2 w-full accent-[#1f7a6f]"
          />
        </div>

        <ScrollArea className="flex-1 px-5 py-4">
          <div className="grid gap-2">
            {['all', ...defaultTags].map((value) => (
              <Button
                key={value}
                size="sm"
                variant={tag === value ? 'soft' : 'ghost'}
                className="w-full justify-start"
                onClick={() => setTag(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-col">
        <header className="border-b border-[#ddd6ca] bg-[#fbfaf7]/90 px-4 py-4 backdrop-blur md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#7b7368]">x.com / for you</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-normal text-[#181512] md:text-3xl">
                Intelligence queue
              </h2>
            </div>
            <Button
              size="icon"
              variant="outline"
              onClick={() => feed.refetch()}
              aria-label="Refresh feed"
              title="Refresh feed"
            >
              <RefreshCw className={cx('size-4', feed.isFetching && 'animate-spin')} />
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8b8378]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="filter summaries, authors, tags"
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2 lg:hidden">
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7368]">score</span>
              <input
                aria-label="Minimum score"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={minScore}
                onChange={(event) => setMinScore(Number(event.target.value))}
                className="h-2 w-24 accent-[#1f7a6f]"
              />
              <span className="w-9 text-right text-sm font-semibold text-[#201c18]">{minScore.toFixed(2)}</span>
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {['all', ...defaultTags].map((value) => (
              <Button
                key={value}
                size="sm"
                variant={tag === value ? 'soft' : 'outline'}
                className="shrink-0"
                onClick={() => setTag(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </header>

        <ScrollArea className="flex-1 px-4 py-4 md:px-6">
          {feed.isLoading ? (
            <div className="grid gap-3">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="h-[154px] rounded-lg border border-[#ddd6ca] bg-white p-4">
                  <div className="mb-4 h-4 w-1/3 rounded bg-[#eee8dd] animate-pulse" />
                  <div className="mb-2 h-4 w-full rounded bg-[#eee8dd] animate-pulse" />
                  <div className="mb-4 h-4 w-5/6 rounded bg-[#eee8dd] animate-pulse" />
                  <div className="flex gap-2">
                    <div className="h-6 w-20 rounded bg-[#eee8dd] animate-pulse" />
                    <div className="h-6 w-24 rounded bg-[#eee8dd] animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : feed.error ? (
            <div role="alert" className="rounded-lg border border-[#e7b8b8] bg-[#fff3f2] p-4 text-sm text-[#9a3412]">
              {feed.error instanceof Error ? feed.error.message : 'feed unavailable'}
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-[#ddd6ca] bg-white p-8 text-sm text-[#6f675d]">
              No synthesis items match the current filters.
            </div>
          ) : (
            <div className="grid gap-3">
              {items.map((item) => (
                <FeedCard
                  key={item.id}
                  item={item}
                  selected={selectedItem?.id === item.id}
                  onSelect={() => {
                    setSelectedId(item.id)
                    setMobileDetailOpen(true)
                  }}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </section>

      <aside className="hidden min-h-0 border-l border-[#ddd6ca] bg-[#fbfaf7] lg:flex">
        {selectedItem ? <DetailPane item={selectedItem} /> : null}
      </aside>

      {mobileDetailOpen && selectedItem ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#fbfaf7] lg:hidden">
          <DetailPane item={selectedItem} onClose={() => setMobileDetailOpen(false)} />
        </div>
      ) : null}
    </main>
  )
}

function FeedCard({ item, selected, onSelect }: { item: SynthesisItem; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cx(
        'group rounded-lg border bg-white p-4 text-left shadow-[0_1px_0_rgba(32,28,24,0.04)] transition-colors',
        selected ? 'border-[#1f7a6f] ring-2 ring-[#1f7a6f]/10' : 'border-[#ddd6ca] hover:border-[#bfb6a8]',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#7b7368]">
            <span className="font-semibold text-[#5d554b]">
              {item.authorHandle ? `@${item.authorHandle}` : 'x.com'}
            </span>
            <span>{formatDate(item.observedAt)}</span>
            <Badge variant={statusVariant(item.engagementStatus)} className="h-5">
              {statusIcon(item.engagementStatus)}
              {item.engagementStatus}
            </Badge>
          </div>
          <p className="mt-3 line-clamp-2 text-base font-semibold leading-6 tracking-normal text-[#181512]">
            {item.summary}
          </p>
          {item.whyValuable ? (
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#6f675d]">{item.whyValuable}</p>
          ) : null}
        </div>
        <div className="flex size-14 shrink-0 flex-col items-center justify-center rounded-lg border border-[#cfe8e1] bg-[#edf8f4] text-[#17665e]">
          <span className="text-lg font-semibold">{Math.round(item.score * 100)}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em]">score</span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {item.topicTags.slice(0, 5).map((topic) => (
          <Badge key={topic}>{topic}</Badge>
        ))}
        <span className="ml-auto hidden text-xs text-[#8b8378] md:inline">run {item.runId.slice(0, 8)}</span>
      </div>
    </button>
  )
}

function DetailPane({ item, onClose }: { item: SynthesisItem; onClose?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-[#ddd6ca] px-5 py-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#5d554b]">
              {item.authorHandle ? `@${item.authorHandle}` : 'x.com'}
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-normal text-[#181512]">Post detail</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AnchorButton
              href={item.originalUrl}
              target="_blank"
              rel="noreferrer"
              size="icon"
              variant="outline"
              aria-label="Open original post"
            >
              <ExternalLink className="size-4" />
            </AnchorButton>
            {onClose ? (
              <Button size="icon" variant="outline" onClick={onClose} aria-label="Close detail">
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Metric label="score" value={item.score.toFixed(2)} />
          <Metric label="confidence" value={item.confidence.toFixed(2)} />
          <Metric label="state" value={item.engagementStatus} />
        </div>
      </header>

      <ScrollArea className="flex-1 px-5 py-5">
        <div className="grid gap-5">
          <DetailSection title="summary">
            <p className="text-base font-semibold leading-7 text-[#181512]">{item.summary}</p>
          </DetailSection>

          {item.whyValuable ? (
            <DetailSection title="why it matters">
              <p className="text-sm leading-6 text-[#514a42]">{item.whyValuable}</p>
            </DetailSection>
          ) : null}

          {item.evidence.length ? (
            <DetailSection title="evidence">
              <ul className="grid gap-2">
                {item.evidence.map((line) => (
                  <li
                    key={line}
                    className="rounded-lg border border-[#ddd6ca] bg-white p-3 text-sm leading-6 text-[#514a42]"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}

          <DetailSection title="observed post">
            <p className="whitespace-pre-wrap rounded-lg border border-[#ddd6ca] bg-white p-3 font-mono text-xs leading-6 text-[#514a42]">
              {item.observedText}
            </p>
          </DetailSection>

          <DetailSection title="actions">
            <div className="flex flex-wrap gap-2">
              <Badge variant="teal">
                <ThumbsUp className="size-3.5" />
                {item.engagementRecommendation}
              </Badge>
              {item.replyText ? (
                <Badge variant="amber">
                  <MessageCircle className="size-3.5" />
                  {item.replyText}
                </Badge>
              ) : null}
              <AnchorButton href={item.originalUrl} target="_blank" rel="noreferrer" size="sm" variant="outline">
                <ArrowUpRight className="size-3.5" />
                original
              </AnchorButton>
            </div>
          </DetailSection>
        </div>
      </ScrollArea>
    </div>
  )
}

function RailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#ddd6ca] bg-[#fbfaf7] px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b8378]">{label}</div>
      <div className="mt-1 text-xl font-semibold tracking-normal text-[#181512]">{value}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#ddd6ca] bg-white px-3 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b8378]">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold tracking-normal text-[#181512]">{value}</div>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b8378]">{title}</h3>
      {children}
    </section>
  )
}
