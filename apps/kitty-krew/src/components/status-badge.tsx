import { cva } from 'class-variance-authority'
import React from 'react'

const statusVariants = {
  Running: 'bg-green-700 text-green-100',
  Pending: 'bg-yellow-700 text-yellow-100',
  Failed: 'bg-red-700 text-red-100',
  Succeeded: 'bg-blue-700 text-blue-100',
  CrashLoopBackOff: 'bg-red-700 text-red-100',
  Terminating: 'bg-orange-700 text-orange-100',
  Evicted: 'bg-purple-700 text-purple-100',
  default: 'bg-zinc-700 text-zinc-100',
}

const statusBadgeVariants = cva(
  'py-0.5 px-4 max-w-fit rounded-full text-xs font-medium flex items-center justify-center gap-0.5 whitespace-nowrap',
  {
    variants: {
      status: statusVariants,
    },
    defaultVariants: {
      status: 'default',
    },
  },
)

type StatusVariant = keyof typeof statusVariants

interface StatusBadgeProps {
  status?: string
}

export const StatusBadge = React.memo(({ status }: StatusBadgeProps) => {
  const getVariantStatus = (status?: string): StatusVariant => {
    if (!status) return 'default'
    return Object.keys(statusVariants).includes(status) ? (status as StatusVariant) : 'default'
  }

  const getStatusIcon = (status?: string) => {
    const variant = getVariantStatus(status)

    switch (variant) {
      case 'Running':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Running status</title>
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'Pending':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Pending status</title>
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'Failed':
      case 'CrashLoopBackOff':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Failed status</title>
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'Succeeded':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Succeeded status</title>
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'Terminating':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Terminating status</title>
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z"
              clipRule="evenodd"
            />
          </svg>
        )
      case 'Evicted':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Evicted status</title>
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
        )
      default:
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-2.5 h-2.5"
            aria-hidden="true"
          >
            <title>Unknown status</title>
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
        )
    }
  }

  return (
    <output className={statusBadgeVariants({ status: getVariantStatus(status) })} aria-live="polite">
      <span className="sr-only">Status:</span>
      {getStatusIcon(status)}
      {status || 'Unknown'}
    </output>
  )
})
