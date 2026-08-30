import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink } from 'lucide-react'

import { normalizeCompanySymbol } from '~/lib/company-symbols'
import type { CompanyProfile } from '~/server/company'

export const Route = createFileRoute('/companies/$symbol')({
  component: CompanyPage,
})

type CompanyResponse = {
  company: CompanyProfile
}

async function fetchCompany(symbol: string): Promise<CompanyProfile> {
  const response = await fetch(`/api/companies/${encodeURIComponent(symbol)}`)
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? `company profile unavailable: ${response.status}`)
  }
  const payload = (await response.json()) as CompanyResponse
  return payload.company
}

function CompanyPage() {
  const { symbol: symbolParam } = Route.useParams()
  const symbol = normalizeCompanySymbol(symbolParam) ?? symbolParam.toUpperCase()
  const company = useQuery({
    queryKey: ['synthesis-company', symbol],
    queryFn: () => fetchCompany(symbol),
    retry: false,
  })

  return (
    <main className="min-h-dvh bg-black text-[#e7e9ea]">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col border-x border-[#2f3336]">
        <header className="border-b border-[#2f3336] px-4 py-3 sm:px-6">
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm text-[#a6a6a6] transition-colors hover:bg-[#181818] hover:text-[#e7e9ea] focus-visible:ring-2 focus-visible:ring-[#1d9bf0]/50"
          >
            <ArrowLeft className="size-4" />
            Synthesis
          </a>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-[#71767b]">Company</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{symbol}</h1>
            </div>
            <span className="rounded-full border border-[#2f3336] px-3 py-1 font-mono text-xs text-[#a6a6a6]">
              Synthesis profile
            </span>
          </div>
        </header>

        <section className="flex-1 px-4 py-5 sm:px-6">
          {company.isLoading ? <CompanyLoading /> : company.error ? <CompanyError error={company.error} /> : null}
          {company.data ? <CompanyProfileView company={company.data} /> : null}
        </section>
      </div>
    </main>
  )
}

export function CompanyProfileView({ company }: { company: CompanyProfile }) {
  const identity = [company.exchange, company.category, company.sector, company.industry].filter(Boolean).join(' · ')
  return (
    <div className="grid gap-5">
      <section className="rounded-lg border border-[#2f3336] bg-[#080808] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.01em]">{company.companyName}</h2>
            {identity ? <p className="mt-1 text-sm text-[#71767b]">{identity}</p> : null}
          </div>
          <span className="rounded-full border border-[#2f3336] px-3 py-1 font-mono text-xs text-[#a6a6a6]">
            confidence {Math.round(company.confidence.score * 100)}%
          </span>
        </div>
        {company.description ? (
          <p className="mt-4 max-w-4xl text-[15px] leading-7 text-[#d8dadd]">{company.description}</p>
        ) : null}
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ProfileFact label="CEO" value={company.ceo} />
          <ProfileFact label="Employees" value={formatNumber(company.employees)} />
          <ProfileFact label="Headquarters" value={company.headquarters} />
          <ProfileFact label="Address" value={company.address} />
          <ProfileFact label="Established" value={company.establishedAt} />
          <ProfileFact label="Incorporated" value={company.incorporatedAt} />
        </dl>
        <p className="mt-4 font-mono text-xs text-[#71767b]">
          Updated {formatDateTime(company.updatedAt)} · Stale after{' '}
          {company.staleness.staleAfter ? formatDateTime(company.staleness.staleAfter) : 'not set'}
        </p>
      </section>

      {company.quoteContext ? (
        <section className="rounded-lg border border-[#2f3336] bg-[#080808] p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[#a6a6a6]">Optional quote context</h3>
            <span className="font-mono text-xs text-[#71767b]">{company.quoteContext.source}</span>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <ProfileFact label="Price" value={formatCurrency(company.quoteContext.price)} />
            <ProfileFact label="Bid" value={formatCurrency(company.quoteContext.bid)} />
            <ProfileFact label="Ask" value={formatCurrency(company.quoteContext.ask)} />
          </dl>
          <p className="mt-3 font-mono text-xs text-[#71767b]">
            Quote time {company.quoteContext.timestamp ? formatDateTime(company.quoteContext.timestamp) : 'unknown'}
          </p>
        </section>
      ) : null}

      <section className="rounded-lg border border-[#2f3336] bg-[#080808] p-4 sm:p-5">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#a6a6a6]">Source provenance</h3>
        <div className="grid gap-3">
          {company.dataSources.map((source) => (
            <div
              key={`${source.name}-${source.url ?? 'local'}`}
              className="rounded-md border border-[#202327] px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-2 text-sm font-semibold text-[#e7e9ea] transition-colors hover:text-[#1d9bf0]"
                  >
                    <span className="truncate">{source.name}</span>
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  <span className="text-sm font-semibold text-[#e7e9ea]">{source.name}</span>
                )}
                <span className="font-mono text-xs text-[#71767b]">{formatDateTime(source.retrievedAt)}</span>
              </div>
              {source.fields.length ? (
                <p className="mt-2 text-xs leading-5 text-[#71767b]">Fields: {source.fields.join(', ')}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function ProfileFact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md border border-[#202327] bg-black/30 px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-[#71767b]">{label}</dt>
      <dd className="mt-1 text-sm leading-6 text-[#e7e9ea]">{value ?? 'unknown'}</dd>
    </div>
  )
}

const formatNumber = (value: number | null) => {
  if (value == null) return null
  return new Intl.NumberFormat('en-US').format(value)
}

const formatCurrency = (value: number | null) => {
  if (value == null) return null
  return new Intl.NumberFormat('en-US', { currency: 'USD', maximumFractionDigits: 2, style: 'currency' }).format(value)
}

const formatDateTime = (value: string) => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function CompanyLoading() {
  return (
    <div className="grid gap-4" aria-label="Loading company profile">
      <div className="h-72 rounded-lg border border-[#2f3336] bg-[#080808] animate-pulse" />
      <div className="h-64 rounded-lg border border-[#2f3336] bg-[#080808] animate-pulse" />
    </div>
  )
}

function CompanyError({ error }: { error: Error }) {
  return (
    <div role="alert" className="rounded-lg border border-[#5f1f2b] bg-[#16070a] px-4 py-4 text-sm text-[#ff9aa5]">
      {error.message}
    </div>
  )
}
