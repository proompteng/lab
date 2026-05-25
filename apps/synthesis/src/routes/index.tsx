import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Filter,
  Home,
  MessageCircle,
  Radar,
  RefreshCw,
  Search,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, UIEvent } from 'react'
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

function HorizontalScrollArea({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={cx(
        'min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    >
      {children}
    </div>
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
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-black text-[#e7e9ea] xl:grid-cols-[244px_minmax(0,640px)_minmax(0,1fr)]">
      <aside className="hidden min-h-0 justify-end border-r border-[#2f3336] bg-black xl:flex">
        <div className="flex w-[244px] flex-col px-2 py-3">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full">
            <Radar className="size-7" />
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
            <label className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-[#202327] px-3 text-[#71767b]">
              <Filter className="size-4" />
              <input
                aria-label="Minimum score"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={minScore}
                onChange={(event) => setMinScore(Number(event.target.value))}
                className="h-1.5 w-20 accent-[#1d9bf0] sm:w-28"
              />
              <span className="w-6 text-right text-xs font-semibold">{formatScore(minScore)}</span>
            </label>
          </div>

          <TopicTabs tag={tag} setTag={setTag} />
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
                <FeedPost key={item.id} item={item} />
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

function TopicTabs({ tag, setTag }: { tag: string; setTag: (value: string) => void }) {
  return (
    <HorizontalScrollArea className="-mx-4 mt-3 border-t border-[#2f3336]">
      <div role="tablist" aria-label="Topic filters" className="flex min-w-max px-4">
        {['all', ...defaultTags].map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tag === value}
            className={cx(
              'relative h-12 shrink-0 px-4 text-[15px] font-semibold tracking-normal transition-colors hover:bg-[#080808]',
              tag === value ? 'text-[#e7e9ea]' : 'text-[#71767b]',
            )}
            onClick={() => setTag(value)}
          >
            <span>{value}</span>
            {tag === value ? (
              <span className="absolute inset-x-4 bottom-0 h-1 rounded-full bg-[#1d9bf0]" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </div>
    </HorizontalScrollArea>
  )
}

function FeedPost({ item }: { item: SynthesisItem }) {
  return (
    <article className="border-b border-[#2f3336] px-4 py-4 transition-colors hover:bg-[#080808]">
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
            <a
              href={item.originalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm transition-colors hover:text-[#1d9bf0]"
            >
              <ArrowUpRight className="size-4" />
              original
            </a>
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
