import { Checkbox } from '@/components/ui/checkbox'
import styles from './timeline.module.css'

export type SourceFilter = 'manual' | 'auto'

interface SourceFilterPanelProps {
  selectedSources: SourceFilter[]
  onSourceSelect: (source: SourceFilter) => void
  onClearFilters: () => void
}

const SOURCE_LABELS: Record<SourceFilter, string> = {
  manual: 'Manual',
  auto: 'Automatic',
}

const SOURCE_NOTES: Record<SourceFilter, string> = {
  manual: 'Recorded by you',
  auto: 'Collected from sources',
}

export function SourceFilterPanel({
  selectedSources,
  onSourceSelect,
  onClearFilters,
}: SourceFilterPanelProps) {
  const sources: SourceFilter[] = ['manual', 'auto']

  return (
    <section className={styles.filterPanel} aria-label="Source filter">
      <div className={styles.filterHeader}>
        <div>
          <h2 className={styles.panelTitle}>Filter by source</h2>
          <p className={styles.panelCopy}>Manual entries and collected evidence.</p>
        </div>
        {selectedSources.length > 0 && selectedSources.length < 2 && (
          <button type="button" className={styles.textButton} onClick={onClearFilters}>
            Clear
          </button>
        )}
      </div>

      <div className={styles.filterList}>
        {sources.map((s) => (
          <div
            key={s}
            className={styles.filterRow}
            data-checked={selectedSources.includes(s) ? 'true' : 'false'}
          >
            {/* 可访问名：勾选框与旁边的纯文本 span 未做 label 关联，
                无障碍树里原本是无名勾选框，role/name 定位（e2e、屏幕阅读器）
                都无法区分 manual 与 auto。 */}
            <Checkbox
              aria-label={`${SOURCE_LABELS[s]} source filter`}
              checked={selectedSources.includes(s)}
              onCheckedChange={() => onSourceSelect(s)}
            />
            <span>{SOURCE_LABELS[s]}</span>
            <span className={styles.filterCount}>{SOURCE_NOTES[s]}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
