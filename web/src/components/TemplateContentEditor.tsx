import { lazy, Suspense, useEffect, useRef } from 'react'
import styles from './library-configuration.module.css'

// next/dynamic({ ssr: false }) → React.lazy + Suspense (ADR-0028). There is no
// server render in the SPA, so the suspense fallback only shows while the
// editor chunk streams in.
const MilkdownEditor = lazy(() =>
  import('@/components/editor/MilkdownEditor').then((module) => ({ default: module.MilkdownEditor })),
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
      <Suspense fallback={null}>
        <MilkdownEditor value={value} onChange={onChange} readOnly={readOnly} />
      </Suspense>
    </div>
  )
}
