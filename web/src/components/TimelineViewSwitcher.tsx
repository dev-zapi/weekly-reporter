import styles from './timeline.module.css'

type ViewMode = 'day' | 'week' | 'month'

interface TimelineViewSwitcherProps {
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
}

const VIEW_MODES: ViewMode[] = ['day', 'week', 'month']
const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

export function TimelineViewSwitcher({ viewMode, onViewModeChange }: TimelineViewSwitcherProps) {
  return (
    <div className={styles.viewSwitcher} role="group" aria-label="Timeline grouping">
      {VIEW_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          className={`${styles.viewButton} ${viewMode === mode ? styles.viewButtonActive : ''}`}
          onClick={() => onViewModeChange(mode)}
          aria-pressed={viewMode === mode}
        >
          {VIEW_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  )
}
