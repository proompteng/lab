import { ScrollArea as DesignScrollArea } from '@proompteng/design/ui'
import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Filter,
  ImageIcon,
  MessageCircle,
  Newspaper,
  RefreshCw,
  Search,
  ThumbsUp,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  UIEvent,
} from 'react'
import type { FeedResponse, SynthesisItem } from '~/server/schema'

export const Route = createFileRoute('/')({
  component: App,
})

const topicTabs = [
  { value: 'all', label: 'all' },
  { value: 'semis', label: 'semis' },
  { value: 'deep-semi-integrations', label: 'deep semis' },
  { value: 'devtools', label: 'devtools' },
  { value: 'software-engineering', label: 'software' },
  { value: 'ai-agents', label: 'agents' },
  { value: 'quant-trading', label: 'quant' },
  { value: 'options', label: 'options' },
  { value: 'machine-learning', label: 'ml' },
  { value: 'trading-systems', label: 'systems' },
] as const

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

function UiScrollArea({ className, children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  if (!isMounted) {
    return (
      <div data-slot="scroll-area" className={cx('relative', className)} {...props}>
        <div data-slot="scroll-area-viewport" className="size-full rounded-[inherit]">
          {children}
        </div>
      </div>
    )
  }

  return (
    <DesignScrollArea className={className} {...props}>
      {children}
    </DesignScrollArea>
  )
}

const buttonClass = (
  variant: 'primary' | 'ghost' = 'primary',
  size: 'default' | 'sm' | 'icon-lg' = 'default',
  className?: string,
) =>
  cx(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-sm font-semibold tracking-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/50 disabled:pointer-events-none disabled:opacity-50',
    variant === 'primary' && 'bg-[#eff3f4] text-black hover:bg-[#d7dbdc]',
    variant === 'ghost' && 'bg-transparent text-[#e7e9ea] hover:bg-[#181818]',
    size === 'default' && 'h-10 px-4',
    size === 'sm' && 'h-8 px-3 text-xs',
    size === 'icon-lg' && 'size-8 rounded-full',
    className,
  )

function Button({
  className,
  variant = 'primary',
  size = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost'
  size?: 'default' | 'sm' | 'icon-lg'
}) {
  return <button className={buttonClass(variant, size, className)} {...props} />
}

function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={className} {...props} />
}

function Badge({
  className,
  variant = 'outline',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: 'outline' | 'secondary' }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium',
        variant === 'secondary'
          ? 'border-transparent bg-[#202327] text-[#e7e9ea]'
          : 'border-[#2f3336] bg-[#080808] text-[#e7e9ea]',
        className,
      )}
      {...props}
    />
  )
}

function Separator({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('h-px w-full shrink-0 bg-[#2f3336]', className)} {...props} />
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

const formatScore = (value: number) => Math.round(value * 100)

const normalizeHandle = (value: string | null) => value?.replace(/^@+/, '').trim() || null
const displayHandle = (value: string | null) => {
  const normalized = normalizeHandle(value)
  return normalized ? `@${normalized}` : '@synthesis'
}

const compactText = (value: string, maxLength = 220) => {
  const cleaned = value
    .replace(/^useful context path for\s+/i, '')
    .replace(/^good deep-integration signal:\s*/i, '')
    .replace(/^high-signal supply-chain map for\s+/i, 'supply-chain map for ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length <= maxLength) return cleaned
  const clipped = cleaned.slice(0, maxLength)
  const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('; '), clipped.lastIndexOf(': '))
  return `${clipped.slice(0, sentenceEnd > 120 ? sentenceEnd + 1 : maxLength).trim()}...`
}

const avatarText = (item: SynthesisItem) => {
  const source = item.authorName || normalizeHandle(item.authorHandle) || 'x'
  const parts = source
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return (parts[0]?.slice(0, 2) || 'X').toUpperCase()
}

const statusLabel = (status: SynthesisItem['engagementStatus']) => {
  if (status === 'queued') return 'queued'
  if (status === 'sent') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'skipped') return 'skipped'
  if (status === 'suppressed') return 'limited'
  return 'none'
}

const statusIcon = (status: SynthesisItem['engagementStatus']) => {
  if (status === 'queued') return <Clock3 />
  if (status === 'sent') return <CheckCircle2 />
  if (status === 'failed') return <X />
  return <Filter />
}

const extractUrls = (text: string) =>
  Array.from(text.matchAll(/https?:\/\/[^\s)\]]+/g), (match) => match[0].replace(/[.,;:]+$/, ''))

const isMediaLikeUrl = (url: string) =>
  url.startsWith('data:image/') ||
  /pbs\.twimg\.com|twimg\.com|\/photo\/\d+|\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)

const isInlineImageUrl = (url: string) =>
  url.startsWith('data:image/') || /pbs\.twimg\.com|twimg\.com|\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)

const mediaUrlsForItem = (item: SynthesisItem) => {
  const urls = new Set<string>()
  for (const url of item.mediaUrls) {
    if (isMediaLikeUrl(url)) urls.add(url)
  }
  for (const url of extractUrls([item.observedText, ...item.evidence].join(' '))) {
    if (isMediaLikeUrl(url)) urls.add(url)
  }
  if (urls.size === 0 && /\bimage\b/i.test(item.observedText)) {
    urls.add(`${item.originalUrl}/photo/1`)
  }
  return [...urls]
}

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
      [item.summary, item.whyValuable, item.observedText, item.authorHandle, item.authorName, item.topicTags.join(' ')]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(lowered)),
    )
  }, [loadedItems, query])

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  )

  useEffect(() => {
    if (!selectedId && items[0]) {
      setSelectedId(items[0].id)
      return
    }
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null)
    }
  }, [items, selectedId])

  const fetchNextPage = () => {
    if (feed.hasNextPage && !feed.isFetchingNextPage) {
      void feed.fetchNextPage()
    }
  }

  const loadMoreIfNeeded = (event: UIEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.dataset.slot !== 'scroll-area-viewport') return
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distanceToBottom < 720) fetchNextPage()
  }

  return (
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-black text-[#e7e9ea] xl:grid-cols-[244px_minmax(0,620px)_minmax(360px,1fr)]">
      <aside className="hidden min-h-0 justify-end border-r border-[#2f3336] bg-black xl:flex">
        <div className="flex w-[244px] flex-col px-2 py-3">
          <div className="mb-3 flex size-12 items-center justify-center rounded-full text-[#1d9bf0]">
            <Newspaper className="size-7" />
          </div>
          <nav className="grid gap-1">
            <RailButton active icon={<Newspaper />}>
              Feed
            </RailButton>
            <RailButton icon={<Search />}>Search</RailButton>
            <RailButton icon={<Filter />}>Filters</RailButton>
          </nav>
          <Button className="mt-5 h-10 w-full rounded-full text-sm">Curate</Button>
          <div className="mt-auto px-3 py-4 text-sm leading-6 text-[#71767b]">
            <p>{loadedItems.length} loaded</p>
            <p>{items.length} visible</p>
          </div>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col border-x border-[#2f3336] bg-black">
        <header className="shrink-0 border-b border-[#2f3336] bg-black/90 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-normal">Synthesis</h1>
              <p className="mt-0.5 text-xs text-[#71767b]">{loadedItems.length} loaded</p>
            </div>
            <Button
              size="icon-lg"
              variant="ghost"
              onClick={() => feed.refetch()}
              aria-label="Refresh feed"
              title="Refresh feed"
            >
              <RefreshCw className={cx('text-[#1d9bf0]', feed.isFetching && 'animate-spin')} />
            </Button>
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#71767b]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className="h-9 rounded-md border-[#2f3336] bg-[#080808] pl-9 text-[15px] text-[#e7e9ea] placeholder:text-[#71767b]"
              />
            </div>
            <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-[#2f3336] bg-[#080808] px-3 text-[#71767b] sm:w-44">
              <Filter className="size-4" />
              <input
                aria-label="Minimum score"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={minScore}
                onChange={(event) => setMinScore(Number(event.target.value))}
                className="h-1.5 min-w-0 flex-1 accent-[#1d9bf0]"
              />
              <span className="w-6 text-right text-xs font-semibold">{formatScore(minScore)}</span>
            </label>
          </div>

          <TopicTabs tag={tag} setTag={setTag} />
        </header>

        <UiScrollArea
          className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain"
          onScrollCapture={loadMoreIfNeeded}
        >
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
              <p className="mt-2 text-[15px] leading-6 text-[#71767b]">Try another tag or lower the score floor.</p>
            </div>
          ) : (
            <>
              {items.map((item) => (
                <FeedPost key={item.id} item={item} selected={item.id === selectedItem?.id} onSelect={setSelectedId} />
              ))}
              <InfiniteFooter
                hasNextPage={Boolean(feed.hasNextPage)}
                isFetchingNextPage={feed.isFetchingNextPage}
                onLoadMore={fetchNextPage}
              />
            </>
          )}
        </UiScrollArea>
      </section>

      <DetailPanel item={selectedItem} />
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
      <span className="[&>svg]:size-6">{icon}</span>
      <span>{children}</span>
    </button>
  )
}

function TopicTabs({ tag, setTag }: { tag: string; setTag: (value: string) => void }) {
  return (
    <UiScrollArea className="-mx-4 mt-3 h-12 min-w-0 border-t border-[#2f3336] [&_[data-slot=scroll-area-scrollbar]]:hidden [&_[data-slot=scroll-area-viewport]]:overflow-x-auto [&_[data-slot=scroll-area-viewport]]:overflow-y-hidden [&_[data-slot=scroll-area-viewport]]:[scrollbar-width:none] [&_[data-slot=scroll-area-viewport]::-webkit-scrollbar]:hidden">
      <div role="tablist" aria-label="Topic filters" className="flex min-w-max px-4">
        {topicTabs.map((topic) => (
          <button
            key={topic.value}
            type="button"
            role="tab"
            aria-selected={tag === topic.value}
            className={cx(
              'relative h-12 shrink-0 px-4 text-[15px] font-semibold tracking-normal transition-colors hover:bg-[#080808]',
              tag === topic.value ? 'text-[#e7e9ea]' : 'text-[#71767b]',
            )}
            onClick={() => setTag(topic.value)}
          >
            <span>{topic.label}</span>
            {tag === topic.value ? (
              <span className="absolute inset-x-4 bottom-0 h-1 rounded-full bg-[#1d9bf0]" aria-hidden="true" />
            ) : null}
          </button>
        ))}
      </div>
    </UiScrollArea>
  )
}

function FeedPost({
  item,
  selected,
  onSelect,
}: {
  item: SynthesisItem
  selected: boolean
  onSelect: (id: string) => void
}) {
  const mediaUrls = mediaUrlsForItem(item)
  const inlineImage = mediaUrls.find(isInlineImageUrl)
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(item.id)
    }
  }

  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(item.id)}
      onKeyDown={handleKeyDown}
      className={cx(
        'cursor-pointer border-b border-[#2f3336] px-4 py-4 outline-none transition-colors hover:bg-[#080808] focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/60 focus-visible:ring-inset',
        selected && 'bg-[#080808]',
      )}
    >
      <div className="flex gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#202327] text-sm font-bold text-[#e7e9ea]">
          {avatarText(item)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[15px]">
            <span className="max-w-[15rem] truncate font-bold">
              {item.authorName ?? displayHandle(item.authorHandle)}
            </span>
            <span className="text-[#71767b]">{displayHandle(item.authorHandle)}</span>
            <span className="text-[#71767b]">-</span>
            <span className="text-[#71767b]">{formatDate(item.observedAt)}</span>
          </div>

          <p className="mt-2 line-clamp-3 text-[15px] leading-6">{compactText(item.summary)}</p>

          {inlineImage ? (
            <div className="mt-3 overflow-hidden rounded-md border border-[#2f3336] bg-[#080808]">
              <img src={inlineImage} alt="" className="max-h-64 w-full object-cover" loading="lazy" />
            </div>
          ) : mediaUrls.length ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-[#2f3336] px-2 py-1 text-xs text-[#71767b]">
              <ImageIcon className="size-3.5" />
              media
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-[#71767b]">
            <span>score {formatScore(item.score)}</span>
            <span>conf {formatScore(item.confidence)}</span>
            <span className="inline-flex items-center gap-1 [&>svg]:size-3.5">
              {statusIcon(item.engagementStatus)}
              {statusLabel(item.engagementStatus)}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-sm text-[#71767b]">
            {item.topicTags.slice(0, 4).map((topic) => (
              <span key={topic}>#{topic}</span>
            ))}
          </div>

          <div className="mt-3 flex max-w-md justify-between text-[#71767b]">
            <span className="inline-flex items-center gap-2 text-sm">
              <MessageCircle className="size-4" />
              {item.engagementRecommendation === 'reply' ? 'queued' : 'reply'}
            </span>
            <span className="inline-flex items-center gap-2 text-sm">
              <ThumbsUp className="size-4" />
              {item.engagementRecommendation === 'like' ? 'queued' : 'like'}
            </span>
            <a
              href={item.originalUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
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

function DetailPanel({ item }: { item: SynthesisItem | null }) {
  return (
    <aside className="hidden min-h-0 min-w-0 flex-col bg-black xl:flex">
      <div className="flex h-[57px] shrink-0 items-center justify-between border-b border-[#2f3336] px-5">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#71767b]">Detail</h2>
        </div>
        {item ? (
          <a href={item.originalUrl} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'sm')}>
            <ExternalLink data-icon="inline-start" />
            Original
          </a>
        ) : null}
      </div>

      <UiScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overflow-x-hidden [&_[data-slot=scroll-area-viewport]]:overflow-y-auto [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        {item ? <DetailContent item={item} /> : <EmptyDetail />}
      </UiScrollArea>
    </aside>
  )
}

function DetailContent({ item }: { item: SynthesisItem }) {
  const mediaUrls = mediaUrlsForItem(item)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-5">
      <div>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#202327] text-sm font-bold">
            {avatarText(item)}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[15px]">
              <span className="font-bold">{item.authorName ?? displayHandle(item.authorHandle)}</span>
              <span className="text-[#71767b]">{displayHandle(item.authorHandle)}</span>
              <span className="text-[#71767b]">-</span>
              <span className="text-[#71767b]">{formatDate(item.observedAt)}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="outline">score {formatScore(item.score)}</Badge>
              <Badge variant="outline">conf {formatScore(item.confidence)}</Badge>
              <Badge variant={item.engagementStatus === 'queued' ? 'secondary' : 'outline'}>
                {statusLabel(item.engagementStatus)}
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <Section title="Synthesis">
        <p className="text-[15px] leading-7">{compactText(item.summary, 420)}</p>
        {item.whyValuable ? (
          <p className="mt-3 text-[15px] leading-7 text-[#a6a6a6]">{compactText(item.whyValuable, 360)}</p>
        ) : null}
      </Section>

      {mediaUrls.length ? (
        <Section title="Media">
          <div className="grid gap-3">
            {mediaUrls.map((url) =>
              isInlineImageUrl(url) ? (
                <img
                  key={url}
                  src={url}
                  alt=""
                  className="max-h-[520px] w-full rounded-md border border-[#2f3336] object-contain"
                  loading="lazy"
                />
              ) : (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-3 rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2 text-sm text-[#e7e9ea] transition-colors hover:border-[#1d9bf0]/60"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ImageIcon className="size-4 shrink-0 text-[#1d9bf0]" />
                    <span className="truncate">{url}</span>
                  </span>
                  <ExternalLink className="size-4 shrink-0 text-[#71767b]" />
                </a>
              ),
            )}
          </div>
        </Section>
      ) : null}

      {item.evidence.length ? (
        <Section title="Evidence">
          <ul className="flex flex-col gap-2 text-[15px] leading-6 text-[#d8dadd]">
            {item.evidence.map((evidence) => (
              <li key={evidence} className="rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2">
                {evidence}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Raw">
        <p className="whitespace-pre-wrap text-sm leading-6 text-[#a6a6a6]">{item.observedText}</p>
      </Section>

      <Separator className="bg-[#2f3336]" />
      <div className="flex flex-wrap gap-2">
        {item.topicTags.map((topic) => (
          <Badge key={topic} variant="outline">
            #{topic}
          </Badge>
        ))}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#71767b]">{title}</h3>
      {children}
    </section>
  )
}

function EmptyDetail() {
  return (
    <div className="flex h-full min-h-[420px] items-center justify-center px-8 text-center text-[#71767b]">
      <div>
        <Newspaper className="mx-auto mb-3 size-8" />
        <p className="text-sm">Select an item to inspect the post, evidence, raw text, and media.</p>
      </div>
    </div>
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
