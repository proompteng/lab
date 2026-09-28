import React from 'react'

interface Option {
  value: string
  label: string
}

interface MultiSelectProps {
  options: Option[]
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  className?: string
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select options...',
  className = '',
}: MultiSelectProps) {
  const [isOpen, setIsOpen] = React.useState(false)
  const [searchInput, setSearchInput] = React.useState('')
  const [focusedIndex, setFocusedIndex] = React.useState(-1)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const optionRefs = React.useRef<(HTMLDivElement | null)[]>([])
  const triggerButtonRef = React.useRef<HTMLButtonElement>(null)
  const dropdownId = React.useId()
  const optionsListId = React.useId()

  // Filter options based on search input
  const filteredOptions = React.useMemo(() => {
    if (!searchInput.trim()) return options

    const searchTerm = searchInput.toLowerCase()
    return options.filter((option) => option.label.toLowerCase().includes(searchTerm))
  }, [options, searchInput])

  // Reset option refs when filtered options change
  React.useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, filteredOptions.length)
  }, [filteredOptions.length])

  const toggleDropdown = () => {
    setIsOpen(!isOpen)
    if (!isOpen) {
      // Focus search input when dropdown opens
      setTimeout(() => {
        searchInputRef.current?.focus()
        setFocusedIndex(-1)
      }, 0)
    } else {
      // Clear search when dropdown closes
      setSearchInput('')
      setFocusedIndex(-1)
    }
  }

  const handleOptionClick = (optionValue: string) => {
    let newValue: string[]

    if (value.includes(optionValue)) {
      newValue = value.filter((v) => v !== optionValue)
    } else {
      newValue = [...value, optionValue]
    }

    // Handle special case for '*' option (represents "all")
    if (optionValue === '*') {
      newValue = ['*']
    } else if (newValue.includes('*')) {
      newValue = newValue.filter((v) => v !== '*')
    }

    // If no options selected, default to '*' (represents "all")
    if (newValue.length === 0) {
      newValue = ['*']
    }

    onChange(newValue)
    // Don't close dropdown after selection
  }

  const handleKeyDown = (event: React.KeyboardEvent, optionValue?: string) => {
    const filteredOptionsLength = filteredOptions.length

    switch (event.key) {
      case 'Enter':
      case ' ':
        if (optionValue) {
          handleOptionClick(optionValue)
          event.preventDefault()
        }
        break
      case 'Escape':
        setIsOpen(false)
        setSearchInput('')
        setFocusedIndex(-1)
        triggerButtonRef.current?.focus()
        event.preventDefault()
        break
      case 'Tab':
        if (event.shiftKey && focusedIndex <= 0) {
          // If shift+tab on first option or search, close dropdown
          setIsOpen(false)
          setSearchInput('')
          setFocusedIndex(-1)
        } else if (!event.shiftKey && focusedIndex === filteredOptionsLength - 1) {
          // If tab on last option, close dropdown
          setIsOpen(false)
          setSearchInput('')
          setFocusedIndex(-1)
        } else {
          // Otherwise, prevent default to keep focus trapped
          event.preventDefault()
          const newIndex = event.shiftKey
            ? Math.max(-1, focusedIndex - 1)
            : Math.min(filteredOptionsLength - 1, focusedIndex + 1)
          setFocusedIndex(newIndex)
        }
        break
      case 'ArrowDown':
        event.preventDefault()
        setFocusedIndex((prev) => Math.min(filteredOptionsLength - 1, prev + 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setFocusedIndex((prev) => Math.max(-1, prev - 1))
        break
      case 'Home':
        event.preventDefault()
        setFocusedIndex(0)
        break
      case 'End':
        event.preventDefault()
        setFocusedIndex(filteredOptionsLength - 1)
        break
      default:
        break
    }
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'ArrowDown':
        event.preventDefault()
        if (!isOpen) {
          setIsOpen(true)
          setTimeout(() => {
            searchInputRef.current?.focus()
          }, 0)
        } else if (event.key === 'ArrowDown') {
          setFocusedIndex(0)
        }
        break
      case 'ArrowUp':
        event.preventDefault()
        if (!isOpen) {
          setIsOpen(true)
          setTimeout(() => {
            const lastIndex = filteredOptions.length - 1
            setFocusedIndex(lastIndex)
          }, 0)
        } else {
          setFocusedIndex(filteredOptions.length - 1)
        }
        break
      case 'Escape':
        if (isOpen) {
          event.preventDefault()
          setIsOpen(false)
          setSearchInput('')
          setFocusedIndex(-1)
        }
        break
      default:
        break
    }
  }

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value)
    setFocusedIndex(-1)
  }

  // Close dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSearchInput('')
        setFocusedIndex(-1)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  // Set up option refs
  const setOptionRef = React.useCallback((element: HTMLDivElement | null, index: number) => {
    optionRefs.current[index] = element
  }, [])

  // Focus the correct element when focusedIndex changes
  React.useEffect(() => {
    if (!isOpen) return

    if (focusedIndex === -1) {
      searchInputRef.current?.focus()
    } else {
      optionRefs.current[focusedIndex]?.focus()
    }
  }, [focusedIndex, isOpen])

  // Get selected options for display
  const selectedOptions = React.useMemo(() => {
    return options.filter((option) => value.includes(option.value))
  }, [options, value])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerButtonRef}
        type="button"
        onClick={toggleDropdown}
        onKeyDown={handleTriggerKeyDown}
        className="w-full h-[38px] px-3 py-1.5 bg-zinc-800 text-zinc-400/90 rounded-md border border-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-600 flex items-center justify-between"
        aria-controls={dropdownId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <span className="text-zinc-400/90 truncate text-sm">
          {selectedOptions.length > 0 ? `${selectedOptions.length} selected` : placeholder}
        </span>
        <svg
          className="h-4 w-4 text-zinc-400"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <title>Toggle dropdown</title>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <dialog
          id={dropdownId}
          className="absolute z-10 mt-1 w-full bg-zinc-800 border border-zinc-700 rounded-md shadow-lg max-h-60 overflow-auto"
          aria-label="Options"
          open
        >
          <div className="p-2 border-b border-zinc-700">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                value={searchInput}
                onChange={handleSearchChange}
                onKeyDown={(e) => handleKeyDown(e)}
                placeholder="Search..."
                className="w-full px-3 py-1 bg-zinc-700 text-zinc-300 rounded-md border border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-500 placeholder:text-zinc-400/50 placeholder:text-sm text-sm"
                aria-controls={optionsListId}
                aria-autocomplete="list"
              />
              <svg
                className="absolute right-2 top-1/2 transform -translate-y-1/2 h-3 w-3 text-zinc-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <title>Search</title>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
          </div>
          <div
            id={optionsListId}
            role="listbox"
            aria-multiselectable="true"
            aria-activedescendant={
              focusedIndex >= 0 && filteredOptions[focusedIndex]
                ? `${optionsListId}-option-${filteredOptions[focusedIndex].value}`
                : undefined
            }
            className="py-1"
            tabIndex={-1}
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => (
                <div
                  key={option.value}
                  id={`${optionsListId}-option-${option.value}`}
                  ref={(el) => setOptionRef(el, index)}
                  role="option"
                  aria-selected={value.includes(option.value)}
                  tabIndex={-1}
                  onClick={() => handleOptionClick(option.value)}
                  onKeyDown={(e) => handleKeyDown(e, option.value)}
                  onMouseEnter={() => setFocusedIndex(index)}
                  className={`text-sm w-full px-3 py-2 flex items-center hover:bg-zinc-700 cursor-pointer text-left ${
                    focusedIndex === index ? 'bg-zinc-700' : ''
                  }`}
                >
                  <div className="mr-2 h-4 w-4 border border-zinc-500 rounded flex items-center justify-center">
                    {value.includes(option.value) && (
                      <svg
                        className="h-3 w-3 text-zinc-300"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <title>Selected</title>
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </div>
                  <span className="text-zinc-300">{option.label}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-zinc-400 text-sm">No options found</div>
            )}
          </div>
        </dialog>
      )}
    </div>
  )
}
