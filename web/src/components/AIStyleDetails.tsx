import { useId, type RefObject } from 'react'
import type { AIStyleRow } from '@/lib/db/schema'
import styles from './ai-style-workbench.module.css'

export function aiStyleParameterLabel(value: string | null, kind: 'detail' | 'result'): string {
  if (!value) return 'Not set'
  if (kind === 'detail') {
    return { low: 'Concise', medium: 'Balanced', high: 'Detailed' }[value] ?? value
  }
  return { low: 'Low', medium: 'Medium', high: 'High' }[value] ?? value
}

function formatTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  try {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  } catch {
    return String(value)
  }
}

export function AIStyleRecordDetails({ style }: { style: AIStyleRow }) {
  return (
    <dl className={styles.detailsList}>
      <div><dt>Name</dt><dd>{style.label}</dd></div>
      <div><dt>Style key</dt><dd>{style.key}</dd></div>
      <div><dt>Default</dt><dd>{style.isDefault ? 'Default style' : 'No'}</dd></div>
      <div><dt>Temperature</dt><dd>{style.temperature}</dd></div>
      <div><dt>Detail level</dt><dd>{aiStyleParameterLabel(style.detailLevel, 'detail')}</dd></div>
      <div><dt>Result orientation</dt><dd>{aiStyleParameterLabel(style.resultOriented, 'result')}</dd></div>
      <div><dt>Created</dt><dd>{formatTime(style.createdAt as unknown as Date | string)}</dd></div>
      <div><dt>Updated</dt><dd>{formatTime(style.updatedAt as unknown as Date | string)}</dd></div>
    </dl>
  )
}

export function AIStylePromptPanel({ style, promptRef }: {
  style: AIStyleRow
  promptRef?: RefObject<HTMLDivElement | null>
}) {
  const titleId = useId()
  return (
    <section className={styles.promptPanel} aria-labelledby={titleId}>
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.recordRef}>S{style.id}</span>
          <h2 id={titleId}>Complete system prompt</h2>
        </div>
        <span className={styles.charCount}>{style.systemPrompt.length} / 5000</span>
      </div>
      <div
        className={styles.promptScroll}
        ref={promptRef}
        tabIndex={0}
        role="region"
        aria-label={`${style.label} complete system prompt`}
      >
        <pre>{style.systemPrompt}</pre>
      </div>
      <div className={styles.scrollHint}>Full text · scroll inside this panel</div>
    </section>
  )
}
