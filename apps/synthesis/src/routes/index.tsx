import { ScrollArea as DesignScrollArea } from '@proompteng/design/ui'
import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowUpRight, ExternalLink, ImageIcon, Newspaper, Search } from 'lucide-react'
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

const isMediaLikeUrl = (url: string) =>
  url.startsWith('data:image/') ||
  url.startsWith('/api/assets/') ||
  /pbs\.twimg\.com|twimg\.com|\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)

const isInlineImageUrl = (url: string) =>
  url.startsWith('data:image/') ||
  url.startsWith('/api/assets/') ||
  /pbs\.twimg\.com|twimg\.com|\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(url)

const mediaUrlsForItem = (item: SynthesisItem) => {
  const urls = new Set<string>()
  for (const attachment of item.attachments) {
    if (isMediaLikeUrl(attachment.assetUrl)) urls.add(attachment.assetUrl)
  }
  return [...urls]
}

const feedMinScore = 0.65

async function fetchFeed(tag: string, query: string, cursor?: string): Promise<FeedResponse> {
  const params = new URLSearchParams({ limit: '24', minScore: String(feedMinScore) })
  if (tag !== 'all') params.set('tag', tag)
  const semanticQuery = query.trim()
  if (semanticQuery) params.set('query', semanticQuery)
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/feed?${params.toString()}`)
  if (!response.ok) throw new Error(`feed request failed: ${response.status}`)
  return (await response.json()) as FeedResponse
}

function App() {
  const [tag, setTag] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const feed = useInfiniteQuery({
    queryKey: ['synthesis-feed', tag, query.trim()],
    queryFn: ({ pageParam }) => fetchFeed(tag, query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 45_000,
  })

  const loadedItems = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data?.pages])
  const items = loadedItems

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
          <nav className="grid gap-1">
            <RailButton active icon={<Newspaper />}>
              Feed
            </RailButton>
            <RailButton icon={<Search />}>Search</RailButton>
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
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-normal">Synthesis</h1>
              <p className="mt-0.5 text-xs text-[#71767b]">{loadedItems.length} loaded</p>
            </div>
          </div>

          <div className="mt-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#71767b]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className="h-9 rounded-md border-[#2f3336] bg-[#080808] pl-9 text-[15px] text-[#e7e9ea] placeholder:text-[#71767b]"
              />
            </div>
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
              <p className="mt-2 text-[15px] leading-6 text-[#71767b]">Try another tag or search.</p>
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

          <h2 className="mt-2 line-clamp-2 text-[16px] font-semibold leading-6">{compactText(item.title, 180)}</h2>
          <p className="mt-1 line-clamp-3 text-[15px] leading-6 text-[#d8dadd]">{compactText(item.synthesis, 280)}</p>

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
            <span>
              {item.sourceCount} source{item.sourceCount === 1 ? '' : 's'}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-sm text-[#71767b]">
            {item.topicTags.slice(0, 4).map((topic) => (
              <span key={topic}>#{topic}</span>
            ))}
          </div>

          <div className="mt-3 flex max-w-md justify-between text-[#71767b]">
            <a
              href={item.originalUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-2 text-sm transition-colors hover:text-[#1d9bf0]"
            >
              <ArrowUpRight className="size-4" />
              source
            </a>
            <span className="inline-flex items-center gap-2 text-sm">
              <ImageIcon className="size-4" />
              {item.attachments.length} attachment{item.attachments.length === 1 ? '' : 's'}
            </span>
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
            Source
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
              <Badge variant="outline">
                {item.sourceCount} source{item.sourceCount === 1 ? '' : 's'}
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <Section title="Synthesis">
        <h1 className="mb-3 text-2xl font-bold leading-8 tracking-normal">{item.title}</h1>
        <p className="text-[15px] leading-7">{compactText(item.synthesis, 900)}</p>
        {item.whyValuable ? (
          <div className="mt-4 rounded-md border border-[#2f3336] bg-[#080808] px-3 py-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#71767b]">Why it matters</h4>
            <p className="text-[15px] leading-7 text-[#d8dadd]">{compactText(item.whyValuable, 520)}</p>
          </div>
        ) : null}
      </Section>

      {item.takeaways.length ? (
        <Section title="Takeaways">
          <ul className="grid gap-2 text-[15px] leading-6 text-[#d8dadd]">
            {item.takeaways.map((takeaway) => (
              <li key={takeaway} className="rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2">
                {takeaway}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {item.factChecks.length ? (
        <Section title="Fact Checks">
          <div className="grid gap-3">
            {item.factChecks.map((factCheck) => (
              <div key={factCheck.claim} className="rounded-md border border-[#2f3336] bg-[#080808] px-3 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant={factCheck.status === 'verified' ? 'secondary' : 'outline'}>{factCheck.status}</Badge>
                  <span className="text-sm font-semibold text-[#e7e9ea]">{factCheck.claim}</span>
                </div>
                <p className="text-sm leading-6 text-[#a6a6a6]">{factCheck.explanation}</p>
                {factCheck.sources.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {factCheck.sources.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 rounded-md border border-[#2f3336] px-2 py-1 text-xs text-[#71767b] transition-colors hover:border-[#1d9bf0]/60 hover:text-[#e7e9ea]"
                      >
                        <span className="truncate">{source.title ?? source.publisher ?? source.url}</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Sources">
        <div className="flex flex-wrap gap-2">
          {item.sourcePosts.map((source, index) => (
            <a
              key={source.postKey}
              href={source.canonicalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-2 rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2 text-sm text-[#e7e9ea] transition-colors hover:border-[#1d9bf0]/60"
            >
              <span className="text-[#71767b]">{index + 1}</span>
              <span className="truncate">
                {source.authorHandle ? displayHandle(source.authorHandle) : 'x.com post'}
              </span>
              <ExternalLink className="size-4 shrink-0 text-[#71767b]" />
            </a>
          ))}
        </div>
      </Section>

      {mediaUrls.length ? (
        <Section title="Attachments">
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
        <p className="text-sm">Select an item to inspect synthesis, sources, fact checks, and attachments.</p>
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
