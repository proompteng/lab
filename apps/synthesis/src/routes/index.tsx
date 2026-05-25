import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Filter,
  Home,
  MessageCircle,
  RefreshCw,
  Search,
  Sparkles,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  UIEvent,
} from 'react'
import type { FeedResponse, SynthesisItem } from '~/server/schema'

export const Route = createFileRoute('/')({
  component: App,
})

const defaultTags = ['semis', 'devtools', 'ai agents', 'quant', 'options', 'ml', 'trading systems']

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

type ButtonVariant = 'primary' | 'ghost' | 'subtle'
type ButtonSize = 'default' | 'sm' | 'icon'

const buttonClass = (variant: ButtonVariant = 'primary', size: ButtonSize = 'default', className?: string) =>
  cx(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-semibold tracking-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/40 disabled:pointer-events-none disabled:opacity-50',
    variant === 'primary' && 'bg-[#eff3f4] text-black hover:bg-[#d7dbdc]',
    variant === 'ghost' && 'bg-transparent text-[#e7e9ea] hover:bg-[#181818]',
    variant === 'subtle' && 'border border-[#2f3336] bg-transparent text-[#e7e9ea] hover:bg-[#080808]',
    size === 'default' && 'h-10 px-4',
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
  variant = 'ghost',
  size = 'default',
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <a className={buttonClass(variant, size, className)} {...props} />
}

function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-11 w-full min-w-0 rounded-full border border-transparent bg-[#202327] px-4 text-[15px] text-[#e7e9ea] outline-none transition-colors placeholder:text-[#71767b] focus:border-[#1d9bf0] focus:bg-black',
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
  if (status === 'queued') return <Clock3 className="size-3.5" />
  if (status === 'sent') return <CheckCircle2 className="size-3.5" />
  if (status === 'failed') return <X className="size-3.5" />
  return <Filter className="size-3.5" />
}

const formatScore = (value: number) => Math.round(value * 100)

async function fetchFeed(tag: string, minScore: number, cursor?: string): Promise<FeedResponse> {
  const params = new URLSearchParams({ limit: '24', minScore: String(minScore) })
  if (tag !== 'all') params.set('tag', tag)
  if (cursor) params.set('cursor', cursor)
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

  const feed = useInfiniteQuery({
    queryKey: ['synthesis-feed', tag, minScore],
    queryFn: ({ pageParam }) => fetchFeed(tag, minScore, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 45_000,
  })

  const loadedItems = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data?.pages])

  const items = useMemo(() => {
    const lowered = query.trim().toLowerCase()
    if (!lowered) return loadedItems
    return loadedItems.filter((item) =>
      [item.summary, item.whyValuable, item.observedText, item.authorHandle, item.topicTags.join(' ')]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(lowered)),
    )
  }, [loadedItems, query])

  const selectedItem = items.find((item) => item.id === selectedId) ?? items[0] ?? null
  const highSignalCount = loadedItems.filter((item) => item.score >= 0.85).length
  const queuedCount = loadedItems.filter((item) => item.engagementStatus === 'queued').length

  const fetchNextPage = () => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) {
      void feed.fetchNextPage()
    }
  }

  const loadMoreIfNeeded = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceToBottom < 720) fetchNextPage()
  }

  return (
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-black text-[#e7e9ea] xl:grid-cols-[244px_minmax(0,640px)_minmax(340px,1fr)]">
      <aside className="hidden min-h-0 justify-end border-r border-[#2f3336] bg-black xl:flex">
        <div className="flex w-[244px] flex-col px-2 py-3">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full">
            <Sparkles className="size-7" />
          </div>
          <nav className="grid gap-1">
            <RailButton active icon={<Home className="size-6" />}>
              Home
            </RailButton>
            <RailButton icon={<Search className="size-6" />}>Explore</RailButton>
            <RailButton icon={<Filter className="size-6" />}>Filters</RailButton>
          </nav>
          <Button className="mt-5 h-12 w-full">Curate</Button>
          <div className="mt-auto px-3 py-4 text-sm leading-6 text-[#71767b]">
            <p>synthesis feed</p>
            <p>{loadedItems.length} loaded</p>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-col border-x border-[#2f3336] bg-black">
        <header className="sticky top-0 z-10 border-b border-[#2f3336] bg-black/85 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-normal">For You</h1>
              <p className="mt-0.5 text-xs text-[#71767b]">{loadedItems.length} loaded</p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => feed.refetch()}
              aria-label="Refresh feed"
              title="Refresh feed"
            >
              <RefreshCw className={cx('size-5 text-[#1d9bf0]', feed.isFetching && 'animate-spin')} />
            </Button>
          </div>

          <div className="mt-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-[#71767b]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search Synthesis"
                className="pl-11"
              />
            </div>
          </div>

          <div className="-mx-4 mt-3 flex gap-1 overflow-x-auto border-t border-[#2f3336] px-4 pt-2">
            {['all', ...defaultTags].map((value) => (
              <button
                key={value}
                type="button"
                className={cx(
                  'shrink-0 rounded-full px-3 py-2 text-sm font-semibold tracking-normal transition-colors hover:bg-[#080808]',
                  tag === value ? 'text-[#1d9bf0]' : 'text-[#e7e9ea]',
                )}
                onClick={() => setTag(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </header>

        <ScrollArea className="flex-1" onScroll={loadMoreIfNeeded}>
          {feed.isLoading ? (
            <div>
              {Array.from({ length: 7 }, (_, index) => (
                <TimelineSkeleton key={index} />
              ))}
            </div>
          ) : feed.error ? (
            <div role="alert" className="border-b border-[#2f3336] px-4 py-5 text-sm text-[#ff7a85]">
              {feed.error instanceof Error ? feed.error.message : 'feed unavailable'}
            </div>
          ) : items.length === 0 ? (
            <div className="px-8 py-16 text-center">
              <h2 className="text-2xl font-bold">No signal here yet</h2>
              <p className="mt-2 text-[15px] leading-6 text-[#71767b]">Try a different tag or lower the score floor.</p>
            </div>
          ) : (
            <>
              {items.map((item) => (
                <FeedPost
                  key={item.id}
                  item={item}
                  selected={selectedItem?.id === item.id}
                  onSelect={() => {
                    setSelectedId(item.id)
                    setMobileDetailOpen(true)
                  }}
                />
              ))}
              <InfiniteFooter
                hasNextPage={Boolean(feed.hasNextPage)}
                isFetchingNextPage={feed.isFetchingNextPage}
                onLoadMore={fetchNextPage}
              />
            </>
          )}
        </ScrollArea>
      </section>

      <aside className="hidden min-h-0 bg-black xl:flex">
        <div className="w-full max-w-[400px] px-5 py-3">
          <FeedControls
            minScore={minScore}
            setMinScore={setMinScore}
            loadedItems={loadedItems}
            highSignalCount={highSignalCount}
            queuedCount={queuedCount}
          />
          {selectedItem ? <DetailPane item={selectedItem} /> : null}
        </div>
      </aside>

      {mobileDetailOpen && selectedItem ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-black xl:hidden">
          <DetailPane item={selectedItem} onClose={() => setMobileDetailOpen(false)} />
        </div>
      ) : null}
    </main>
  )
}

function RailButton({ active, icon, children }: { active?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(
        'flex w-fit items-center gap-4 rounded-full px-4 py-3 text-xl tracking-normal transition-colors hover:bg-[#181818]',
        active ? 'font-bold text-[#e7e9ea]' : 'font-normal text-[#e7e9ea]',
      )}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

function FeedControls({
  minScore,
  setMinScore,
  loadedItems,
  highSignalCount,
  queuedCount,
}: {
  minScore: number
  setMinScore: (value: number) => void
  loadedItems: SynthesisItem[]
  highSignalCount: number
  queuedCount: number
}) {
  return (
    <section className="border-b border-[#2f3336] pb-5">
      <h2 className="text-xl font-bold tracking-normal">Synthesis</h2>
      <p className="mt-2 text-sm leading-6 text-[#71767b]">
        {loadedItems.length} loaded · {highSignalCount} high signal · {queuedCount} queued
      </p>
      <label className="mt-5 block">
        <span className="flex items-center justify-between text-sm">
          <span className="font-semibold">Minimum score</span>
          <span className="text-[#71767b]">{minScore.toFixed(2)}</span>
        </span>
        <input
          aria-label="Minimum score"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={minScore}
          onChange={(event) => setMinScore(Number(event.target.value))}
          className="mt-3 h-2 w-full accent-[#1d9bf0]"
        />
      </label>
    </section>
  )
}

function FeedPost({ item, selected, onSelect }: { item: SynthesisItem; selected: boolean; onSelect: () => void }) {
  return (
    <article
      className={cx(
        'cursor-pointer border-b border-[#2f3336] px-4 py-4 hover:bg-[#080808]',
        selected && 'bg-white/[0.03]',
      )}
      onClick={onSelect}
    >
      <div className="flex gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#202327] text-sm font-bold text-[#e7e9ea]">
          {(item.authorHandle?.[0] ?? 'x').toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[15px]">
            <span className="font-bold">{item.authorName ?? item.authorHandle ?? 'x.com'}</span>
            <span className="truncate text-[#71767b]">
              {item.authorHandle ? `@${item.authorHandle}` : '@synthesis'}
            </span>
            <span className="text-[#71767b]">·</span>
            <span className="text-[#71767b]">{formatDate(item.observedAt)}</span>
          </div>

          <p className="mt-2 text-[15px] leading-6">{item.summary}</p>
          {item.whyValuable ? <p className="mt-2 text-[15px] leading-6 text-[#71767b]">{item.whyValuable}</p> : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[#71767b]">
            <span>score {formatScore(item.score)}</span>
            <span>confidence {formatScore(item.confidence)}</span>
            <span className="inline-flex items-center gap-1">
              {statusIcon(item.engagementStatus)}
              {item.engagementStatus}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm text-[#71767b]">
            {item.topicTags.slice(0, 5).map((topic) => (
              <span key={topic}>#{topic}</span>
            ))}
          </div>

          <div className="mt-3 flex max-w-md justify-between text-[#71767b]">
            <span className="inline-flex items-center gap-2 text-sm">
              <MessageCircle className="size-4" />
              {item.engagementRecommendation === 'reply' ? 'reply queued' : 'reply'}
            </span>
            <span className="inline-flex items-center gap-2 text-sm">
              <ThumbsUp className="size-4" />
              {item.engagementRecommendation === 'like' ? 'like queued' : 'like'}
            </span>
            <span className="inline-flex items-center gap-2 text-sm">
              <ArrowUpRight className="size-4" />
              original
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}

const InfiniteFooter = ({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}) => (
  <div className="border-b border-[#2f3336] px-4 py-6 text-center">
    {hasNextPage ? (
      <Button variant="ghost" onClick={onLoadMore} disabled={isFetchingNextPage}>
        {isFetchingNextPage ? 'Loading more' : 'Show more'}
      </Button>
    ) : (
      <span className="text-sm text-[#71767b]">End of loaded synthesis</span>
    )}
  </div>
)

function TimelineSkeleton() {
  return (
    <div className="border-b border-[#2f3336] px-4 py-4">
      <div className="flex gap-3">
        <div className="size-10 rounded-full bg-[#202327] animate-pulse" />
        <div className="flex-1">
          <div className="mb-3 h-4 w-1/3 rounded bg-[#202327] animate-pulse" />
          <div className="mb-2 h-4 w-full rounded bg-[#202327] animate-pulse" />
          <div className="mb-2 h-4 w-5/6 rounded bg-[#202327] animate-pulse" />
          <div className="h-4 w-2/3 rounded bg-[#202327] animate-pulse" />
        </div>
      </div>
    </div>
  )
}

function DetailPane({ item, onClose }: { item: SynthesisItem; onClose?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black xl:border-b xl:border-[#2f3336]">
      <header className="border-b border-[#2f3336] px-4 py-4 xl:px-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#71767b]">
              {item.authorHandle ? `@${item.authorHandle}` : '@synthesis'}
            </p>
            <h2 className="mt-1 text-xl font-bold tracking-normal">Post detail</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AnchorButton
              href={item.originalUrl}
              target="_blank"
              rel="noreferrer"
              size="icon"
              aria-label="Open original post"
            >
              <ExternalLink className="size-5" />
            </AnchorButton>
            {onClose ? (
              <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close detail">
                <X className="size-5" />
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-sm leading-6 text-[#71767b]">
          score {formatScore(item.score)} · confidence {formatScore(item.confidence)} · {item.engagementStatus}
        </p>
      </header>

      <ScrollArea className="flex-1 px-4 py-4 xl:px-0">
        <div className="grid gap-5">
          <DetailSection title="Summary">
            <p className="text-[15px] leading-6">{item.summary}</p>
          </DetailSection>

          {item.whyValuable ? (
            <DetailSection title="Why it matters">
              <p className="text-[15px] leading-6 text-[#d6d9db]">{item.whyValuable}</p>
            </DetailSection>
          ) : null}

          {item.evidence.length ? (
            <DetailSection title="Evidence">
              <ul className="grid gap-2 text-sm leading-6 text-[#d6d9db]">
                {item.evidence.map((line) => (
                  <li key={line} className="border-l border-[#2f3336] pl-3">
                    {line}
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}

          <DetailSection title="Observed post">
            <p className="whitespace-pre-wrap border-l border-[#2f3336] pl-3 text-sm leading-6 text-[#d6d9db]">
              {item.observedText}
            </p>
          </DetailSection>

          <DetailSection title="Actions">
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[#71767b]">
              <span>{item.engagementRecommendation}</span>
              {item.replyText ? <span>reply: {item.replyText}</span> : null}
              <span>run {item.runId.slice(0, 8)}</span>
            </div>
          </DetailSection>
        </div>
      </ScrollArea>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold text-[#71767b]">{title}</h3>
      {children}
    </section>
  )
}
