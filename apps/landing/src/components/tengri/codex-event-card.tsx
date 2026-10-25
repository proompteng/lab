'use client'

import {
  BookOpen,
  ChevronRight,
  FileDiff,
  ListChecks,
  LoaderCircle,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { memo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkWorkspaceImageBudget } from './markdown-image-budget'

import { cn } from '@/lib/utils'
import type { TengriCodexEventKind } from '@/lib/tengri/types'
import type { CodexApprovalDecision } from './codex-events'
import { CodexCopyButton } from './codex-copy-button'
import { codexActivityTitle } from './codex-activity'
import {
  codexImageUrl,
  codexMessageAttachments,
  codexOutputImagePaths,
  type TengriCodexImage,
} from '@/lib/tengri/codex-images'
import { CodexMermaid } from './codex-mermaid'
import { WorkspaceFileLink, WorkspaceImage } from './workspace-file-link'

type CodexEventCardProps = {
  agentId?: string
  activityTitle?: string
  images?: readonly TengriCodexImage[]
  approvalDecisions?: readonly CodexApprovalDecision[]
  approvalId?: string
  approvalTitle?: string
  kind: TengriCodexEventKind
  onResolveApproval?: (decision: CodexApprovalDecision) => void
  resolvingApproval?: boolean
  text: string
}

export const CodexEventCard = memo(function CodexEventCard({
  agentId,
  activityTitle,
  images,
  approvalDecisions = ['approve-once', 'approve-session', 'deny'],
  approvalId,
  approvalTitle,
  kind,
  onResolveApproval,
  resolvingApproval = false,
  text,
}: CodexEventCardProps) {
  if (kind === 'user-message') {
    const attachments = agentId ? codexMessageAttachments(text) : { text, paths: [] }
    const body = images?.length ? text.replace(/\[Image\]/g, '').trim() : attachments.text
    const sources = images?.length
      ? images.map(codexImageUrl)
      : attachments.paths.map((path) => `/api/tengri/attachments?${new URLSearchParams({ agentId: agentId!, path })}`)
    return (
      <article
        aria-label="Your message"
        className="ml-auto w-fit min-w-0 max-w-[min(85%,456px)] rounded-2xl bg-white/[0.04] px-3.5 py-2 text-left text-copy-14 text-zinc-100"
      >
        {sources.length ? (
          <div className="mb-2 flex flex-wrap gap-2" aria-label="Sent images">
            {sources.map((src, index) => (
              <MessageImage key={`${index}:${src}`} src={src} index={index} />
            ))}
          </div>
        ) : null}
        {body ? <Markdown text={body} /> : null}
      </article>
    )
  }

  if (kind === 'approval' && approvalId && onResolveApproval) {
    return (
      <article aria-label="Codex approval request" className="rounded-xl bg-zinc-900/40 px-3 py-2">
        <div className="flex items-start gap-2">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400/65" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h3 className="text-label-14 text-zinc-200">{approvalTitle || 'Approval needed'}</h3>
            {approvalTitle ? (
              <>
                <p className="mt-0.5 text-label-12 text-zinc-400">The agent wants to use your Chrome browser.</p>
                <details className="group mt-1 text-label-12 text-zinc-400">
                  <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded outline-none marker:content-none hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400">
                    <ChevronRight className="size-3 group-open:rotate-90" aria-hidden="true" />
                    Request details
                  </summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-copy-13-mono">{text}</pre>
                </details>
              </>
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-copy-14 text-zinc-300">
                {text || 'Codex is requesting approval.'}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1">
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
                  primary={
                    !approvalDecisions.includes('approve-once') && !approvalDecisions.includes('approve-session')
                  }
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
                <span className="px-1 text-label-12 text-zinc-400" role="status">
                  No supported response is available.
                </span>
              ) : null}
              {resolvingApproval ? (
                <span className="inline-flex items-center gap-1 px-1 text-label-12 text-zinc-400" role="status">
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> Resolving…
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </article>
    )
  }

  if (kind === 'reasoning-summary') {
    return (
      <details className="group text-copy-14 text-zinc-400">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-lg px-1 text-label-14 outline-none marker:content-none transition-colors hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none">
          <ChevronRight
            className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
          Reasoning summary
        </summary>
        <div className="mt-2 pl-6 text-copy-14 text-zinc-400">
          <Markdown text={text} />
        </div>
      </details>
    )
  }

  if (kind === 'tool-call' || kind === 'tool-output' || kind === 'file-diff') {
    const presentation = {
      'file-diff': { label: 'Changes', icon: FileDiff },
      'tool-call': { label: 'Activity', icon: Wrench },
      'tool-output': { label: 'Output', icon: TerminalSquare },
    }[kind]
    const outputImages = kind === 'tool-output' || kind === 'tool-call' ? codexOutputImagePaths(text) : []
    const title = codexActivityTitle(activityTitle ? 'tool-call' : kind, activityTitle || text)
    const Icon =
      kind === 'file-diff'
        ? FileDiff
        : { file: BookOpen, search: Search, terminal: TerminalSquare, tool: Wrench }[title.icon]
    const preview = title.text
    return (
      <article aria-label={`Codex ${presentation.label.toLowerCase()}`} className="min-w-0 text-copy-14">
        <details className="group/activity-row min-w-0">
          <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 rounded px-1 py-0.5 text-zinc-400 outline-none marker:content-none transition-colors hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-400 motion-reduce:transition-none">
            <Icon className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
            <span className="min-w-0 truncate text-label-14">{preview}</span>
            <ChevronRight
              className="size-3 shrink-0 opacity-0 transition-[opacity,transform] group-hover/activity-row:opacity-100 group-focus-within/activity-row:opacity-100 group-open/activity-row:rotate-90 group-open/activity-row:opacity-100 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <pre className="tengri-chat-scrollbar mt-1 mb-2 ml-6 max-h-80 overflow-auto rounded-md bg-zinc-900/40 px-3 py-2 text-copy-13-mono whitespace-pre text-zinc-300">
            {kind === 'file-diff'
              ? text.split('\n').map((line, index) => (
                  <span
                    key={index}
                    className={cn(
                      'block',
                      line.startsWith('+') && !line.startsWith('+++') && 'text-emerald-300',
                      line.startsWith('-') && !line.startsWith('---') && 'text-red-300',
                      line.startsWith('@@') && 'text-blue-300',
                    )}
                  >
                    {line || '\u00a0'}
                  </span>
                ))
              : text}
          </pre>
        </details>
        {outputImages.map((path, index) => (
          <WorkspaceImage key={`${index}:${path}`} src={path} />
        ))}
      </article>
    )
  }

  if (kind === 'plan') {
    return (
      <article aria-label="Codex plan" className="px-1 py-2 text-copy-14 text-zinc-300">
        <div className="mb-2 flex items-center gap-2 text-label-12 text-zinc-400 uppercase">
          <ListChecks className="size-3.5" aria-hidden="true" />
          Plan
        </div>
        <Markdown text={text} />
      </article>
    )
  }

  if (kind === 'warning' || kind === 'error') {
    return (
      <article
        className={cn('text-copy-14', kind === 'error' ? 'text-red-300' : 'text-zinc-400')}
        role={kind === 'error' ? 'alert' : 'status'}
      >
        {text || (kind === 'error' ? 'Codex reported an error.' : 'Codex reported a warning.')}
      </article>
    )
  }

  if (!text || kind === 'thread-state' || kind === 'unknown' || kind === 'usage') return null
  return (
    <article aria-label="Codex response" className="min-w-0 text-left text-copy-14 text-zinc-200">
      <Markdown text={text} />
    </article>
  )
})

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
        'inline-flex min-h-6 items-center rounded-md px-1.5 text-xs leading-4 font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40 motion-reduce:transition-none',
        primary
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'border border-white/[0.08] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function MessageImage({ src, index }: { src: string; index: number }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span role="status" className="text-label-12 text-zinc-400">
      Image {index + 1} unavailable
    </span>
  ) : (
    <img
      src={src}
      alt={`Attached image ${index + 1}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-h-64 max-w-full rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words [&>p+p]:mt-3.5 [&_a]:text-blue-300 [&_a]:underline [&_a]:decoration-blue-300/40 [&_a]:underline-offset-4 [&_blockquote]:my-3.5 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-4 [&_blockquote]:text-zinc-400 [&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:bg-zinc-800/90 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-copy-13-mono [&_h1]:mb-3 [&_h1]:text-heading-20 [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-heading-16 [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-heading-14 [&_li+li]:mt-1.5 [&_ol]:my-3.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-3.5 [&_ul]:list-disc [&_ul]:pl-5 [&_input]:mr-2 [&_input]:accent-blue-500 [&_hr]:my-5 [&_hr]:border-zinc-800">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm, remarkWorkspaceImageBudget]}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ children }: { children: ReactNode }) {
  const codeRef = useRef<HTMLPreElement | null>(null)
  return (
    <div className="my-4 overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/50">
      <div className="flex items-center justify-between border-b border-zinc-800/90 bg-zinc-900/40 px-3 py-1.5 text-label-12 text-zinc-400">
        <span className="text-label-12 text-zinc-400 uppercase">Code</span>
        <CodexCopyButton label="Copy code block" value={() => codeRef.current?.textContent || ''} />
      </div>
      <pre ref={codeRef} className="overflow-auto p-3.5 text-copy-13-mono text-zinc-200">
        {children}
      </pre>
    </div>
  )
}

const markdownComponents: Components = {
  input: ({ checked, type }) => (
    <input aria-label={checked ? 'Completed task' : 'Incomplete task'} checked={checked} disabled type={type} />
  ),
  a: ({ children, href }) => <WorkspaceFileLink href={href}>{children}</WorkspaceFileLink>,
  img: ({ src, alt }) => <WorkspaceImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  pre: ({ children, node }) => {
    const code = node?.children[0]
    const fallback = <CodeBlock>{children}</CodeBlock>
    if (
      code?.type === 'element' &&
      code.tagName === 'code' &&
      Array.isArray(code.properties.className) &&
      code.properties.className.includes('language-mermaid')
    ) {
      const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
      return <CodexMermaid source={source}>{fallback}</CodexMermaid>
    }
    return fallback
  },
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-zinc-700/50">
      <table className="w-full border-collapse text-left text-copy-14 [&_td]:border-t [&_td]:border-zinc-800 [&_td]:px-3 [&_td]:py-2 [&_th]:bg-zinc-800/60 [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium [&_th]:text-zinc-200">
        {children}
      </table>
    </div>
  ),
}
