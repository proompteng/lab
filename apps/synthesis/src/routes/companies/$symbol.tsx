import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowLeft, BarChart3, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

import { normalizeCompanySymbol } from '~/lib/company-symbols'
import type { CompanyAnalysis, CompanyMetric } from '~/server/company'

export const Route = createFileRoute('/companies/$symbol')({
  component: CompanyPage,
})

type CompanyResponse = {
  company: CompanyAnalysis
}

async function fetchCompany(symbol: string): Promise<CompanyAnalysis> {
  const response = await fetch(`/api/companies/${encodeURIComponent(symbol)}`)
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? `company analysis unavailable: ${response.status}`)
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
            <a
              href={`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-[#2f3336] px-3 py-2 text-sm text-[#a6a6a6] transition-colors hover:border-[#1d9bf0]/60 hover:text-[#e7e9ea]"
            >
              Market source
              <ExternalLink className="size-4" />
            </a>
          </div>
        </header>

        <section className="flex-1 px-4 py-5 sm:px-6">
          {company.isLoading ? <CompanyLoading /> : company.error ? <CompanyError error={company.error} /> : null}
          {company.data ? <CompanyAnalysisView company={company.data} /> : null}
        </section>
      </div>
    </main>
  )
}

function CompanyAnalysisView({ company }: { company: CompanyAnalysis }) {
  return (
    <div className="grid gap-5">
      <section className="rounded-lg border border-[#2f3336] bg-[#080808] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.01em]">{company.identity.name}</h2>
            <p className="mt-1 text-sm text-[#71767b]">
              {[company.identity.exchange, company.identity.sector, company.identity.industry]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <span className="rounded-full border border-[#2f3336] px-3 py-1 font-mono text-xs text-[#a6a6a6]">
            {company.source}
          </span>
        </div>
        {company.identity.description ? (
          <p className="mt-4 max-w-4xl text-[15px] leading-7 text-[#d8dadd]">{company.identity.description}</p>
        ) : null}
        <p className="mt-4 font-mono text-xs text-[#71767b]">Updated {new Date(company.updatedAt).toLocaleString()}</p>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <MetricSection
          icon={<BarChart3 className="size-4" />}
          title="Fundamental analysis"
          metrics={company.fundamentals}
        />
        <MetricSection title="Technical analysis" metrics={company.technicals} />
        <MetricSection title="Financial analysis" metrics={company.financials} />
      </div>
    </div>
  )
}

function MetricSection({ icon, title, metrics }: { icon?: ReactNode; title: string; metrics: CompanyMetric[] }) {
  return (
    <section className="rounded-lg border border-[#2f3336] bg-[#080808] p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[#a6a6a6]">
        {icon}
        {title}
      </h3>
      {metrics.length ? (
        <dl className="grid gap-2">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="flex items-baseline justify-between gap-3 border-t border-[#202327] pt-2"
            >
              <dt className="text-sm text-[#71767b]">{metric.label}</dt>
              <dd className="text-right font-mono text-sm text-[#e7e9ea]">{metric.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm leading-6 text-[#71767b]">Current market-data fields are unavailable.</p>
      )}
    </section>
  )
}

function CompanyLoading() {
  return (
    <div className="grid gap-4" aria-label="Loading company analysis">
      <div className="h-36 rounded-lg border border-[#2f3336] bg-[#080808] animate-pulse" />
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-64 rounded-lg border border-[#2f3336] bg-[#080808] animate-pulse" />
        ))}
      </div>
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
