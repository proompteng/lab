'use client'

import { LoaderCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'

import { cn } from '@/lib/utils'
import type { TengriCodexEventKind } from '@/lib/tengri/types'
import type { CodexApprovalDecision } from './codex-events'

type CodexEventCardProps = {
  approvalDecisions?: readonly CodexApprovalDecision[]
  approvalId?: string
  kind: TengriCodexEventKind
  onResolveApproval?: (decision: CodexApprovalDecision) => void
  resolvingApproval?: boolean
  text: string
}

export function CodexEventCard({
  approvalDecisions = ['approve-once', 'approve-session', 'deny'],
  approvalId,
  kind,
  onResolveApproval,
  resolvingApproval = false,
  text,
}: CodexEventCardProps) {
  if (kind === 'user-message') {
    return (
      <article aria-label="Your message" className="text-sm leading-5 text-white/90">
        <div className="mb-1 text-[11px] font-medium text-white/42">You</div>
        <Markdown text={text} />
      </article>
    )
  }

  if (kind === 'approval' && approvalId && onResolveApproval) {
    return (
      <article aria-label="Codex approval request" className="border-l-2 border-amber-300/65 pl-2 text-sm leading-5">
        <div className="text-xs font-semibold text-amber-100">Approval required</div>
        <p className="mt-1 whitespace-pre-wrap text-amber-50/82">{text || 'Codex is requesting approval.'}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {approvalDecisions.includes('approve-once') ? (
            <ApprovalButton
              disabled={resolvingApproval}
              label="Approve once"
              onClick={() => onResolveApproval('approve-once')}
              primary
            />
          ) : null}
          {approvalDecisions.includes('approve-session') ? (
            <ApprovalButton
              disabled={resolvingApproval}
              label="Approve for session"
              onClick={() => onResolveApproval('approve-session')}
              primary={!approvalDecisions.includes('approve-once')}
            />
          ) : null}
          {approvalDecisions.includes('approve-exec-policy-amendment') ? (
            <ApprovalButton
              disabled={resolvingApproval}
              label="Apply command policy"
              onClick={() => onResolveApproval('approve-exec-policy-amendment')}
              primary={!approvalDecisions.includes('approve-once') && !approvalDecisions.includes('approve-session')}
            />
          ) : null}
          {approvalDecisions.includes('approve-network-policy-amendment') ? (
            <ApprovalButton
              disabled={resolvingApproval}
              label="Apply network policy"
              onClick={() => onResolveApproval('approve-network-policy-amendment')}
              primary={
                !approvalDecisions.includes('approve-once') &&
                !approvalDecisions.includes('approve-session') &&
                !approvalDecisions.includes('approve-exec-policy-amendment')
              }
            />
          ) : null}
          {approvalDecisions.includes('deny') ? (
            <ApprovalButton disabled={resolvingApproval} label="Deny" onClick={() => onResolveApproval('deny')} />
          ) : null}
          {approvalDecisions.length === 0 ? (
            <span className="text-xs text-amber-100/58" role="status">
              No supported response is available.
            </span>
          ) : null}
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
      <details className="text-sm text-white/64">
        <summary className="cursor-default list-none text-xs font-medium text-white/52 outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-white/50">
          Reasoning summary
        </summary>
        <div className="mt-1 leading-5">
          <Markdown text={text} />
        </div>
      </details>
    )
  }

  if (kind === 'tool-call' || kind === 'tool-output' || kind === 'file-diff') {
    const presentation = {
      'file-diff': { label: 'Changes' },
      'tool-call': { label: 'Operation' },
      'tool-output': { label: 'Output' },
    }[kind]
    return (
      <article aria-label={`Codex ${presentation.label.toLowerCase()}`} className="text-sm">
        <div className="text-[11px] font-medium text-white/42">{presentation.label}</div>
        <pre className="mt-1 max-h-80 overflow-auto border-l border-white/14 bg-black/18 px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap text-white/68">
          {text}
        </pre>
      </article>
    )
  }

  if (kind === 'plan') {
    return (
      <article aria-label="Codex plan" className="text-sm leading-5 text-white/72">
        <div className="mb-1 text-xs font-medium text-violet-100/72">Plan</div>
        <Markdown text={text} />
      </article>
    )
  }

  if (kind === 'warning' || kind === 'error') {
    return (
      <article
        className={cn(
          'border-l-2 pl-2 text-sm leading-5',
          kind === 'error' ? 'border-red-400/65 text-red-100' : 'border-amber-300/60 text-amber-50/88',
        )}
        role={kind === 'error' ? 'alert' : 'status'}
      >
        {text || (kind === 'error' ? 'Codex reported an error.' : 'Codex reported a warning.')}
      </article>
    )
  }

  if (kind === 'usage') {
    return text ? <p className="py-1 text-center text-[11px] text-white/32">{text}</p> : null
  }

  if (!text || kind === 'thread-state' || kind === 'unknown') return null
  return (
    <article aria-label="Codex response" className="text-sm leading-5 text-white/78">
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
    <div className="[&>p+p]:mt-2 [&_a]:text-[#79b8ff] [&_a]:underline [&_code]:rounded [&_code]:bg-white/7 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-auto [&_pre]:bg-black/25 [&_pre]:px-3 [&_pre]:py-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
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
