'use client'

import dynamic from 'next/dynamic'
import { useEffect, useRef } from 'react'
import styles from './library-configuration.module.css'

const MilkdownEditor = dynamic(
  () => import('@/components/editor/MilkdownEditor').then((module) => ({ default: module.MilkdownEditor })),
  { ssr: false },
)

interface TemplateContentEditorProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
}

export function TemplateContentEditor({ value, onChange, readOnly = false }: TemplateContentEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const labelEditor = () => {
      const editor = root.querySelector<HTMLElement>('.ProseMirror')
      if (!editor) return false
      editor.setAttribute('aria-label', 'Template content')
      editor.setAttribute('aria-readonly', String(readOnly))
      return true
    }

    if (labelEditor()) return

    const observer = new MutationObserver(() => {
      if (labelEditor()) observer.disconnect()
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [readOnly])

  return (
    <div ref={rootRef} className={styles.editorField}>
      <MilkdownEditor value={value} onChange={onChange} readOnly={readOnly} />
    </div>
  )
}
