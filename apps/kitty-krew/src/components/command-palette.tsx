import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '~/app/router.tsx'
import type { Pod } from '~/common/schemas/pod.ts'
import { cn } from '~/utils/cn.ts'
import { StatusBadge } from './status-badge.tsx'

export function CommandPalette() {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const commandPaletteRef = useRef<HTMLDivElement>(null)

  const {
    data: pods,
    isLoading,
    error,
  } = useQuery({
    ...trpc.pod.list.queryOptions(),
    enabled: isOpen,
    staleTime: 10000, // 10 seconds
  })

  const filteredPods = useMemo(() => {
    return pods
      ? pods.filter(
          (pod) =>
            pod.metadata?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            pod.metadata?.namespace?.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : []
  }, [pods, searchQuery])

  useEffect(() => {
    setSelectedIndex(0)
  }, [])

  // Clear search query when command palette is closed
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('')
    }
  }, [isOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // CMD+K or Ctrl+K to open
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(true)
      }

      // Escape to close
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  useEffect(() => {
    // Handle click outside to close
    const handleClickOutside = (e: MouseEvent) => {
      if (commandPaletteRef.current && !commandPaletteRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev < filteredPods.length - 1 ? prev + 1 : prev))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0))
    } else if (e.key === 'Enter' && filteredPods.length > 0) {
      e.preventDefault()
      if (selectedIndex >= 0 && selectedIndex < filteredPods.length) {
        const selectedPod = filteredPods[selectedIndex]
        navigateToPod(selectedPod)
      }
    }
  }

  const navigateToPod = (pod: Pod) => {
    if (pod.metadata?.name && pod.metadata?.namespace) {
      navigate({
        to: '/pods/$namespace/$podName',
        params: {
          namespace: pod.metadata.namespace,
          podName: pod.metadata.name,
        },
      })
      setIsOpen(false)
    }
  }

  if (!isOpen) return null

  const activeOptionId = filteredPods[selectedIndex]?.metadata?.name
    ? `pod-${filteredPods[selectedIndex].metadata?.namespace}-${filteredPods[selectedIndex].metadata?.name}`
    : undefined

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[20vh]">
      <div
        ref={commandPaletteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden"
      >
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search for pods..."
            aria-label="Search for pods"
            className="w-full p-4 bg-zinc-900 text-zinc-200 placeholder-zinc-500 border-b border-zinc-700 focus:outline-none focus:ring-0"
            autoComplete="off"
          />
          <kbd className="absolute right-4 top-4 inline-flex gap-1 px-2 py-1 text-xs text-zinc-400 bg-zinc-800 rounded border border-zinc-700">
            <span className="text-xs">esc</span>
            <span className="text-xs">to close</span>
          </kbd>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {isLoading && (
            <div className="p-4 text-center text-zinc-500">
              <span className="animate-pulse">Loading pods...</span>
            </div>
          )}

          {error && (
            <div className="p-4 text-center text-zinc-500">
              <span className="text-red-400">Failed to load pods. Please try again.</span>
            </div>
          )}

          {!isLoading && filteredPods.length === 0 && (
            <div className="p-4 text-center text-zinc-500">
              {searchQuery ? 'No pods match your search' : 'Type to search for pods'}
            </div>
          )}

          {!isLoading && filteredPods.length > 0 && (
            <div
              className="divide-y divide-zinc-800"
              role="listbox"
              tabIndex={0}
              aria-label="Pod search results"
              aria-activedescendant={activeOptionId}
            >
              {filteredPods.map((pod, index) => {
                const optionId = `pod-${pod.metadata?.namespace}-${pod.metadata?.name}`

                return (
                  <div
                    key={`${pod.metadata?.namespace}/${pod.metadata?.name}`}
                    id={optionId}
                    role="option"
                    aria-selected={index === selectedIndex}
                    tabIndex={-1}
                    className={cn(
                      'text-left px-4 py-3 cursor-pointer flex justify-between items-center hover:bg-zinc-800 transition-colors focus:outline-none',
                      index === selectedIndex && 'bg-zinc-800',
                    )}
                    onClick={() => navigateToPod(pod)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigateToPod(pod)
                      }
                    }}
                  >
                    <div className="flex flex-col">
                      <span className="text-zinc-200 font-medium">{pod.metadata?.name}</span>
                      <span className="text-zinc-400 text-sm">Namespace: {pod.metadata?.namespace}</span>
                    </div>
                    <StatusBadge status={pod.status?.phase || ''} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
