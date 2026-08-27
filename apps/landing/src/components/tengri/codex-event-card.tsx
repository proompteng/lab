'use client'

import { Bot, Braces, CircleAlert, FileDiff, ListChecks, LoaderCircle, TerminalSquare } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

import { cn } from '@/lib/utils'
import type { TengriCodexEventKind } from '@/lib/tengri/types'

type ApprovalDecision = 'approve-once' | 'approve-session' | 'deny'

type CodexEventCardProps = {
  approvalId?: string
  kind: TengriCodexEventKind
  onResolveApproval?: (decision: ApprovalDecision) => void
  resolvingApproval?: boolean
  text: string
}

export function CodexEventCard({
  approvalId,
  kind,
  onResolveApproval,
  resolvingApproval = false,
  text,
}: CodexEventCardProps) {
  if (kind === 'user-message') {
    return (
      <article className="ml-[18%] rounded-2xl border border-[#2574e8]/20 bg-[#2574e8]/12 p-4 text-sm leading-6 text-white/88">
        <Markdown text={text} />
      </article>
    )
  }

  if (kind === 'approval' && approvalId && onResolveApproval) {
    return (
      <article
        aria-label="Codex approval request"
        className="mr-[8%] rounded-2xl border border-amber-300/18 bg-amber-300/[0.055] p-4 text-sm leading-6"
      >
        <div className="flex items-center gap-2 text-xs font-semibold text-amber-100">
          <CircleAlert className="h-4 w-4" aria-hidden="true" /> Approval required
        </div>
        <p className="mt-2 whitespace-pre-wrap text-amber-50/82">{text || 'Codex is requesting approval.'}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ApprovalButton
            disabled={resolvingApproval}
            label="Approve once"
            onClick={() => onResolveApproval('approve-once')}
            primary
          />
          <ApprovalButton
            disabled={resolvingApproval}
            label="Approve for session"
            onClick={() => onResolveApproval('approve-session')}
          />
          <ApprovalButton disabled={resolvingApproval} label="Deny" onClick={() => onResolveApproval('deny')} />
          {resolvingApproval ? (
            <span className="inline-flex items-center gap-1.5 px-1 text-xs text-white/48" role="status">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Resolving…
            </span>
          ) : null}
        </div>
      </article>
    )
  }

  if (kind === 'reasoning-summary') {
    return (
      <details className="mr-[8%] rounded-2xl border border-white/7 bg-white/[0.025] px-4 py-3 text-sm text-white/64">
        <summary className="cursor-default list-none text-xs font-medium text-white/52 marker:content-none">
          Reasoning summary
        </summary>
        <div className="mt-3 border-t border-white/7 pt-3 leading-6">
          <Markdown text={text} />
        </div>
      </details>
    )
  }

  if (kind === 'tool-call' || kind === 'tool-output' || kind === 'file-diff') {
    const presentation = {
      'file-diff': { icon: FileDiff, label: 'Changes' },
      'tool-call': { icon: TerminalSquare, label: 'Operation' },
      'tool-output': { icon: Braces, label: 'Output' },
    }[kind]
    const Icon = presentation.icon
    return (
      <article className="mr-[8%] overflow-hidden rounded-2xl border border-white/7 bg-black/18 text-sm">
        <div className="flex items-center gap-2 border-b border-white/7 px-4 py-2 text-[11px] font-medium text-white/42">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {presentation.label}
        </div>
        <pre className="max-h-80 overflow-auto p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap text-white/68">
          {text}
        </pre>
      </article>
    )
  }

  if (kind === 'plan') {
    return (
      <article className="mr-[8%] rounded-2xl border border-violet-300/10 bg-violet-300/[0.035] p-4 text-sm leading-6 text-white/72">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-violet-100/72">
          <ListChecks className="h-4 w-4" aria-hidden="true" /> Plan
        </div>
        <Markdown text={text} />
      </article>
    )
  }

  if (kind === 'warning' || kind === 'error') {
    return (
      <article
        className={cn(
          'mr-[8%] rounded-2xl border p-4 text-sm leading-6',
          kind === 'error'
            ? 'border-red-400/15 bg-red-400/[0.055] text-red-100'
            : 'border-amber-300/14 bg-amber-300/[0.045] text-amber-50/88',
        )}
        role={kind === 'error' ? 'alert' : 'status'}
      >
        {text || (kind === 'error' ? 'Codex reported an error.' : 'Codex reported a warning.')}
      </article>
    )
  }

  if (kind === 'usage') {
    return text ? <p className="px-4 text-center text-[11px] text-white/32">{text}</p> : null
  }

  if (!text || kind === 'thread-state' || kind === 'unknown') return null
  return (
    <article className="mr-[8%] rounded-2xl border border-white/7 bg-white/[0.03] p-4 text-sm leading-6 text-white/78">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-white/38">
        <Bot className="h-3.5 w-3.5" aria-hidden="true" /> Codex
      </div>
      <Markdown text={text} />
    </article>
  )
}

function ApprovalButton({
  disabled,
  label,
  onClick,
  primary = false,
}: {
  disabled: boolean
  label: string
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-lg px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40',
        primary ? 'bg-[#2574e8] text-white hover:bg-[#3981e9]' : 'bg-white/9 text-white/78 hover:bg-white/13',
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="[&_a]:text-[#79b8ff] [&_a]:underline [&_code]:rounded [&_code]:bg-white/7 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-black/25 [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  )
}

const markdownComponents: Components = {
  a: ({ children, href }) => (
    <a href={href} rel="noreferrer noopener" target="_blank">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-white/42">[Image{alt ? `: ${alt}` : ''}]</span>,
}
