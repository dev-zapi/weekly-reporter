
import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Command,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from '@/components/ui/command'

interface AutoCompleteInputProps {
  value: string
  onChange: (value: string) => void
  suggestions: string[]
  placeholder?: string
  className?: string
  disabled?: boolean
  /** Character that triggers completion (default: none, always show on focus) */
  trigger?: string
  /** Custom render for each item */
  renderItem?: (item: string, isHighlighted: boolean) => React.ReactNode
  /** Called when an item is selected */
  onSelect?: (item: string) => void
  /** Whether to show "create new" option when no match */
  allowCreate?: boolean
  /** Label for create option */
  createLabel?: (text: string) => string
}

export function AutoCompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
  disabled,
  trigger,
  renderItem,
  onSelect,
  allowCreate = false,
  createLabel = (text) => `+ Create "${text}"`,
}: AutoCompleteInputProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [filterText, setFilterText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLDivElement>(null)

  // Get current fragment being typed (after last trigger char or comma)
  const getCurrentFragment = useCallback((): string => {
    if (!trigger) {
      // No trigger - use text after last comma
      const lastComma = value.lastIndexOf(',')
      return (lastComma >= 0 ? value.slice(lastComma + 1) : value).trim()
    }

    // With trigger - find the last trigger char
    const triggerIndex = value.lastIndexOf(trigger)
    if (triggerIndex < 0) return ''
    return value.slice(triggerIndex + trigger.length).trim()
  }, [value, trigger])

  // Filter suggestions based on current fragment
  const fragment = getCurrentFragment()
  // Get values that are already committed (before the current fragment)
  const allValues = value.split(',').map(v => v.trim()).filter(Boolean)
  const existingValues = allValues.filter(v => v !== fragment)
  const filtered = suggestions.filter(s =>
    s.toLowerCase().includes(fragment.toLowerCase()) &&
    !existingValues.includes(s)
  )

  // Show create option if allowed and no exact match
  const showCreate = allowCreate &&
    fragment.trim() &&
    !suggestions.some(s => s.toLowerCase() === fragment.toLowerCase())

  // Handle input change
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    onChange(newValue)

    if (trigger) {
      // Only show dropdown if trigger char is present
      const hasTrigger = newValue.includes(trigger)
      setShowDropdown(hasTrigger)
      if (hasTrigger) {
        const triggerIndex = newValue.lastIndexOf(trigger)
        setFilterText(newValue.slice(triggerIndex + trigger.length))
      }
    } else {
      // Always show dropdown when there's text
      setShowDropdown(newValue.length > 0)
      setFilterText(getCurrentFragmentFromValue(newValue))
    }
  }

  // Get fragment from a specific value (for use in handleChange)
  function getCurrentFragmentFromValue(val: string): string {
    if (!trigger) {
      const lastComma = val.lastIndexOf(',')
      return (lastComma >= 0 ? val.slice(lastComma + 1) : val).trim()
    }
    const triggerIndex = val.lastIndexOf(trigger)
    if (triggerIndex < 0) return ''
    return val.slice(triggerIndex + trigger.length).trim()
  }

  // Handle item selection
  const handleSelect = useCallback((item: string) => {
    if (!inputRef.current) return

    const input = inputRef.current
    const cursorPos = input.selectionStart || value.length

    if (trigger) {
      // Replace from trigger char to cursor with selected item + trigger + space
      const triggerIndex = value.lastIndexOf(trigger, cursorPos - 1)
      if (triggerIndex >= 0) {
        const before = value.slice(0, triggerIndex)
        const after = value.slice(cursorPos)
        const newValue = before + trigger + item + trigger + ' ' + after
        onChange(newValue)

        // Set cursor after the inserted item
        const newCursorPos = before.length + trigger.length + item.length + trigger.length + 1
        setTimeout(() => {
          input.setSelectionRange(newCursorPos, newCursorPos)
          input.focus()
        }, 0)
      }
    } else {
      // Comma-separated: replace current fragment with selected item
      const lastComma = value.lastIndexOf(',', cursorPos - 1)
      const before = lastComma >= 0 ? value.slice(0, lastComma + 1) + ' ' : ''
      const after = value.slice(cursorPos)
      const newValue = before + item + ', ' + after

      onChange(newValue)

      // Set cursor after the inserted item
      const newCursorPos = newValue.length - after.length
      setTimeout(() => {
        input.setSelectionRange(newCursorPos, newCursorPos)
        input.focus()
      }, 0)
    }

    setShowDropdown(false)
    onSelect?.(item)
  }, [value, onChange, trigger, onSelect])

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || !commandRef.current) return

    if (e.key === 'Escape') {
      e.preventDefault()
      setShowDropdown(false)
      return
    }

    // Forward arrow keys to Command
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const commandList = commandRef.current.querySelector('[cmdk-list]')
      if (commandList) {
        const event = new KeyboardEvent('keydown', {
          key: e.key,
          bubbles: true,
          cancelable: true,
        })
        commandList.dispatchEvent(event)
      }
      return
    }

    // Handle Enter to select
    if (e.key === 'Enter') {
      e.preventDefault()
      const selectedItem = commandRef.current.querySelector('[data-selected="true"]')
      if (selectedItem) {
        const itemValue = selectedItem.getAttribute('data-value')
        if (itemValue) {
          if (itemValue.startsWith('__create_')) {
            handleSelect(fragment)
          } else {
            handleSelect(itemValue)
          }
        }
      } else if (filtered.length > 0) {
        handleSelect(filtered[0])
      }
      return
    }
  }

  // Handle focus
  const handleFocus = () => {
    if (!trigger || value.includes(trigger)) {
      setShowDropdown(true)
    }
  }

  // Handle blur
  const handleBlur = () => {
    setTimeout(() => {
      setShowDropdown(false)
    }, 200)
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        className={className || 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'}
        disabled={disabled}
      />

      {showDropdown && (filtered.length > 0 || showCreate) && (
        <div
          ref={commandRef}
          className="absolute z-50 mt-1 w-full"
        >
          <Command className="rounded-lg border shadow-md bg-popover">
            <CommandList className="max-h-60">
              <CommandEmpty>No matches</CommandEmpty>
              <CommandGroup>
                {filtered.slice(0, 10).map(item => (
                  <CommandItem
                    key={item}
                    value={item}
                    onSelect={() => handleSelect(item)}
                  >
                    {renderItem ? renderItem(item, false) : item}
                  </CommandItem>
                ))}
                {showCreate && (
                  <CommandItem
                    value={`__create_${fragment}`}
                    onSelect={() => handleSelect(fragment)}
                    className="text-primary"
                  >
                    {createLabel(fragment)}
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  )
}
