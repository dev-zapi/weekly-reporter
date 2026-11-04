'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import styles from './timeline.module.css'

interface QuickInputBarProps {
  onSubmit: (data: { content: string }) => Promise<void> | void
  placeholder?: string
}

export function QuickInputBar({
  onSubmit,
  placeholder = 'Record a work item...'
}: QuickInputBarProps) {
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!loading && inputRef.current) {
      inputRef.current.focus()
    }
  }, [loading])

  const handleSubmit = async () => {
    const trimmedValue = value.trim()

    if (!trimmedValue) {
      return
    }

    setLoading(true)

    try {
      await onSubmit({ content: trimmedValue })
      setValue('')
      toast.success('Recorded')
    } catch (error) {
      console.error('Failed to submit:', error)
      toast.error('Submission failed')
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return
    }
    if (e.key === 'Enter' && !loading) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <section className={styles.capturePanel} aria-label="Quick capture">
      <div className={styles.sectionHeading}>
        <div>
          <h2>Capture work</h2>
          <p>Use @id to cite events and %id to cite plan items. Manual entries stay editable.</p>
        </div>
        <Plus size={18} aria-hidden="true" />
      </div>
      <div className={styles.captureControls}>
        <Input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          className={styles.captureInput}
          aria-label={placeholder}
        />
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleSubmit}
          disabled={loading || !value.trim()}
        >
          Add to timeline
        </button>
      </div>
    </section>
  )
}
