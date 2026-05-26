import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowUpRight, ExternalLink, ImageIcon, Newspaper, Search, X } from 'lucide-react'
import { useEffect, useMemo, useReducer, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  UIEvent,
} from 'react'
import {
  imageModalCaptionId,
  imageModalTitleId,
  initialImageModalState,
  reduceImageModalState,
} from '~/lib/image-modal'
import { normalizeCompanySymbol, segmentCompanySymbols, symbolsFromSynthesisItem } from '~/lib/company-symbols'
import { synthesisSearchInputClassName, synthesisSidebarItems } from '~/lib/synthesis-ui-contract'
import type { FeedResponse, SynthesisAttachment, SynthesisItem } from '~/server/schema'

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
  return (
    <div data-slot="scroll-area" className={cx('relative overflow-hidden', className)} {...props}>
      <div data-slot="scroll-area-viewport" className="size-full rounded-[inherit]">
        {children}
      </div>
    </div>
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

const mediaAttachmentsForItem = (item: SynthesisItem) => {
  return item.attachments.filter((attachment) => isMediaLikeUrl(attachment.assetUrl))
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
  const [imageModal, dispatchImageModal] = useReducer(reduceImageModalState, initialImageModalState)

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
  const selectedModalAttachment = useMemo(() => {
    if (!imageModal.imageId) return null
    return items.flatMap((item) => item.attachments).find((attachment) => attachment.id === imageModal.imageId) ?? null
  }, [imageModal.imageId, items])

  useEffect(() => {
    if (!imageModal.isOpen) return undefined
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      dispatchImageModal({ type: 'escape', key: event.key })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imageModal.isOpen])

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
    <main className="grid h-dvh w-full grid-cols-1 overflow-hidden bg-black text-[#e7e9ea] xl:grid-cols-[220px_minmax(0,760px)_minmax(360px,1fr)]">
      <aside className="hidden min-h-0 justify-end border-r border-[#2f3336] bg-black xl:flex">
        <div className="flex w-[220px] flex-col px-2 py-3">
          <nav className="grid gap-1" aria-label="Synthesis navigation">
            {synthesisSidebarItems.map((item) => (
              <RailButton key={item} active={item === 'Feed'} icon={<Newspaper />}>
                {item}
              </RailButton>
            ))}
          </nav>
          <div className="mt-auto px-3 py-4 font-mono text-xs leading-6 text-[#71767b]">private reading output</div>
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-col border-x border-[#2f3336] bg-black">
        <header className="shrink-0 border-b border-[#2f3336] bg-black/90 px-4 py-3 backdrop-blur sm:px-5">
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-[-0.01em]">Synthesis</h1>
              <p className="mt-0.5 text-xs text-[#71767b]">curated research feed</p>
            </div>
          </div>

          <div className="mt-3 w-full">
            <div className="relative w-full min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#71767b]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search"
                className={synthesisSearchInputClassName}
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
                <FeedPost
                  key={item.id}
                  item={item}
                  selected={item.id === selectedItem?.id}
                  onOpenImage={(imageId) => dispatchImageModal({ type: 'open', imageId })}
                  onSelect={setSelectedId}
                />
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

      <DetailPanel item={selectedItem} onOpenImage={(imageId) => dispatchImageModal({ type: 'open', imageId })} />

      {imageModal.isOpen && selectedModalAttachment ? (
        <AttachmentImageModal
          attachment={selectedModalAttachment}
          onClose={() => dispatchImageModal({ type: 'close' })}
        />
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
  onOpenImage,
  onSelect,
}: {
  item: SynthesisItem
  selected: boolean
  onOpenImage: (imageId: string) => void
  onSelect: (id: string) => void
}) {
  const mediaAttachments = mediaAttachmentsForItem(item)
  const inlineImage = mediaAttachments.find((attachment) => isInlineImageUrl(attachment.assetUrl))
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

          <h2 className="mt-2 line-clamp-2 text-[16px] font-semibold leading-6">
            <SymbolLinkedText text={compactText(item.title, 180)} onClick={(event) => event.stopPropagation()} />
          </h2>
          <p className="mt-1 line-clamp-3 text-[15px] leading-6 text-[#d8dadd]">
            <SymbolLinkedText text={compactText(item.synthesis, 280)} onClick={(event) => event.stopPropagation()} />
          </p>

          {inlineImage ? (
            <button
              type="button"
              className="mt-3 block w-full overflow-hidden rounded-md border border-[#2f3336] bg-[#080808] text-left transition-colors hover:border-[#1d9bf0]/60 focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/50"
              aria-label="Open attachment image"
              onClick={(event) => {
                event.stopPropagation()
                onOpenImage(inlineImage.id)
              }}
            >
              <img
                src={inlineImage.assetUrl}
                alt={inlineImage.alt ?? inlineImage.label ?? ''}
                className="max-h-64 w-full object-cover"
                loading="lazy"
              />
            </button>
          ) : mediaAttachments.length ? (
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

          {item.topicTags.length ? (
            <div className="mt-3 flex flex-wrap gap-2 text-sm text-[#71767b]">
              {item.topicTags.slice(0, 4).map((topic) => (
                <TopicTagLink key={topic} topic={topic} onClick={(event) => event.stopPropagation()} />
              ))}
            </div>
          ) : null}

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

function DetailPanel({ item, onOpenImage }: { item: SynthesisItem | null; onOpenImage: (imageId: string) => void }) {
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
        {item ? <DetailContent item={item} onOpenImage={onOpenImage} /> : <EmptyDetail />}
      </UiScrollArea>
    </aside>
  )
}

function DetailContent({ item, onOpenImage }: { item: SynthesisItem; onOpenImage: (imageId: string) => void }) {
  const mediaAttachments = mediaAttachmentsForItem(item)

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
        <h1 className="mb-3 text-2xl font-bold leading-8 tracking-[-0.01em]">
          <SymbolLinkedText text={item.title} />
        </h1>
        <p className="text-[15px] leading-7">
          <SymbolLinkedText text={compactText(item.synthesis, 900)} />
        </p>
        {item.whyValuable ? (
          <div className="mt-4 rounded-md border border-[#2f3336] bg-[#080808] px-3 py-3">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#71767b]">Why it matters</h4>
            <p className="text-[15px] leading-7 text-[#d8dadd]">
              <SymbolLinkedText text={compactText(item.whyValuable, 520)} />
            </p>
          </div>
        ) : null}
      </Section>

      {item.takeaways.length ? (
        <Section title="Takeaways">
          <ul className="grid gap-2 text-[15px] leading-6 text-[#d8dadd]">
            {item.takeaways.map((takeaway) => (
              <li key={takeaway} className="rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2">
                <SymbolLinkedText text={takeaway} />
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

      {mediaAttachments.length ? (
        <Section title="Attachments">
          <div className="grid gap-3">
            {mediaAttachments.map((attachment) =>
              isInlineImageUrl(attachment.assetUrl) ? (
                <figure key={attachment.id} className="overflow-hidden rounded-md border border-[#2f3336] bg-[#080808]">
                  <button
                    type="button"
                    className="block w-full bg-black focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/50"
                    aria-label="Open attachment image"
                    onClick={() => onOpenImage(attachment.id)}
                  >
                    <img
                      src={attachment.assetUrl}
                      alt={attachment.alt ?? attachment.label ?? ''}
                      className="max-h-[520px] w-full object-contain"
                      loading="lazy"
                    />
                  </button>
                  {attachment.label || attachment.alt ? (
                    <figcaption className="border-t border-[#2f3336] px-3 py-2 text-sm leading-6 text-[#a6a6a6]">
                      {attachment.label ? <p className="font-semibold text-[#e7e9ea]">{attachment.label}</p> : null}
                      {attachment.alt ? <p>{attachment.alt}</p> : null}
                    </figcaption>
                  ) : null}
                </figure>
              ) : (
                <a
                  key={attachment.id}
                  href={attachment.assetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-3 rounded-md border border-[#2f3336] bg-[#080808] px-3 py-2 text-sm text-[#e7e9ea] transition-colors hover:border-[#1d9bf0]/60"
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <ImageIcon className="size-4 shrink-0 text-[#1d9bf0]" />
                    <span className="truncate">{attachment.label ?? attachment.assetUrl}</span>
                  </span>
                  <ExternalLink className="size-4 shrink-0 text-[#71767b]" />
                </a>
              ),
            )}
          </div>
        </Section>
      ) : null}

      <Separator className="bg-[#2f3336]" />
      {item.topicTags.length || symbolsFromSynthesisItem(item).length ? (
        <div className="flex flex-wrap gap-2">
          {item.topicTags.map((topic) => (
            <TopicTagLink key={topic} topic={topic} />
          ))}
          {symbolsFromSynthesisItem(item).map((symbol) => (
            <a
              key={symbol}
              href={`/companies/${symbol}`}
              className="inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-full border border-[#2f3336] bg-[#080808] px-2 py-0.5 font-mono text-[0.625rem] font-medium text-[#e7e9ea] transition-colors hover:border-[#1d9bf0]/60"
            >
              ${symbol}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SymbolLinkedText({
  text,
  onClick,
}: {
  text: string
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <>
      {segmentCompanySymbols(text).map((segment, index) =>
        segment.kind === 'symbol' ? (
          <a
            key={`${segment.symbol}-${index}`}
            href={segment.href}
            onClick={onClick}
            className="font-mono text-[#e7e9ea] underline decoration-[#1d9bf0]/60 underline-offset-2 transition-colors hover:text-[#1d9bf0]"
          >
            {segment.text}
          </a>
        ) : (
          <span key={`text-${index}`}>{segment.text}</span>
        ),
      )}
    </>
  )
}

function TopicTagLink({ topic, onClick }: { topic: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  const symbol = normalizeCompanySymbol(topic)
  if (symbol) {
    return (
      <a
        href={`/companies/${symbol}`}
        onClick={onClick}
        className="inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-full border border-[#2f3336] bg-[#080808] px-2 py-0.5 font-mono text-[0.625rem] font-medium text-[#e7e9ea] transition-colors hover:border-[#1d9bf0]/60"
      >
        ${symbol}
      </a>
    )
  }

  return (
    <span className="inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-full border border-[#2f3336] bg-[#080808] px-2 py-0.5 text-[0.625rem] font-medium text-[#e7e9ea]">
      #{topic}
    </span>
  )
}

function AttachmentImageModal({ attachment, onClose }: { attachment: SynthesisAttachment; onClose: () => void }) {
  const caption = [attachment.label, attachment.alt].filter(Boolean).join(' — ')
  const titleId = imageModalTitleId(attachment.id)
  const captionId = imageModalCaptionId(attachment.id)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={caption ? captionId : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-3 py-4 backdrop-blur-sm sm:px-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[#2f3336] bg-[#080808] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-[#2f3336] px-3 py-2 sm:px-4">
          <h2 id={titleId} className="truncate text-sm font-semibold text-[#e7e9ea]">
            {attachment.label ?? 'Attachment image'}
          </h2>
          <button
            type="button"
            aria-label="Close image preview"
            autoFocus
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[#a6a6a6] transition-colors hover:bg-[#181818] hover:text-[#e7e9ea] focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/50"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
          <img
            src={attachment.assetUrl}
            alt={attachment.alt ?? attachment.label ?? ''}
            className="max-h-[78dvh] max-w-full object-contain"
          />
        </div>
        {caption ? (
          <p id={captionId} className="border-t border-[#2f3336] px-3 py-2 text-sm leading-6 text-[#a6a6a6] sm:px-4">
            {caption}
          </p>
        ) : null}
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
