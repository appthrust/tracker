// Searchable option picker in a popover (status, priority, assignee, labels,
// related issues). The search box is an ARIA combobox driving a listbox:
// ↑/↓ move, Enter picks, Escape closes and returns focus to the trigger.
// Single-choice pickers close on pick; `multiple` toggles and stays open.
import { Check } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from './cn'

export type PickerOption = { value: string; label: string; icon?: ReactNode; hint?: string; keywords?: string }

export function Picker({
  label,
  options,
  selected,
  multiple = false,
  onPick,
  onQueryChange,
  placeholder,
  empty,
  children,
  align = 'start',
  open: controlledOpen,
  onOpenChange,
}: {
  /** Accessible name of the search box and list ("状態を変更"). */
  label: string
  options: readonly PickerOption[]
  selected: readonly string[]
  multiple?: boolean
  onPick: (value: string) => void
  /** Remote search (people, issues): options are already filtered by the caller. */
  onQueryChange?: (query: string) => void
  placeholder?: string
  empty: string
  /** The trigger (one focusable element). */
  children: ReactNode
  align?: 'start' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
    if (!next) {
      setQuery('')
      onQueryChange?.('')
    }
  }
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const needle = query.trim().toLowerCase()
  const visible = onQueryChange || !needle ? options : options.filter((option) => `${option.label} ${option.keywords ?? ''}`.toLowerCase().includes(needle))
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0))

  const pick = (value: string) => {
    onPick(value)
    if (!multiple) setOpen(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + visible.length) % Math.max(visible.length, 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const option = visible[activeIndex]
      if (option) pick(option.value)
    } else if (/^[0-9]$/.test(event.key) && !query) {
      // Digit hints (status 1–9, priority 0–4) pick directly while the search box is empty.
      const option = visible.find((candidate) => candidate.hint === event.key)
      if (option) {
        event.preventDefault()
        pick(option.value)
      }
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className="z-50 w-64 overflow-hidden rounded-lg border border-line bg-white shadow-lg animate-pop-in focus:outline-none"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <input
            autoFocus
            role="combobox"
            aria-label={label}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={visible[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            value={query}
            placeholder={placeholder ?? label}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
              onQueryChange?.(event.target.value)
            }}
            onKeyDown={onKeyDown}
            className="block h-9 w-full border-b border-line px-3 text-sm text-stone-900 placeholder:text-stone-400 focus:outline-none"
          />
          <ul id={listId} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="max-h-72 overflow-y-auto p-1">
            {visible.length === 0 ? <li className="px-2 py-2 text-xs text-stone-500">{empty}</li> : null}
            {visible.map((option, index) => {
              const isSelected = selected.includes(option.value)
              return (
                <li
                  key={option.value}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  onPointerMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option.value)}
                  className={cn(
                    'flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-stone-700 [&_svg]:size-3.5 [&_svg]:shrink-0',
                    index === activeIndex && 'bg-stone-100 text-stone-900'
                  )}
                >
                  {option.icon ? <span className="flex shrink-0 items-center">{option.icon}</span> : null}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint ? <span className="shrink-0 text-[11px] text-stone-400">{option.hint}</span> : null}
                  {isSelected ? <Check aria-hidden className="text-accent" /> : null}
                </li>
              )
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
