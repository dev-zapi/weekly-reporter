'use client'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

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

export function SourceFilterPanel({
  selectedSources,
  onSourceSelect,
  onClearFilters,
}: SourceFilterPanelProps) {
  const sources: SourceFilter[] = ['manual', 'auto']

  return (
    <div className="space-y-4 p-4 border rounded-lg">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Filter by source</h3>
        {selectedSources.length > 0 && selectedSources.length < 2 && (
          <Button size="sm" variant="ghost" onClick={onClearFilters}>
            Clear
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {sources.map((s) => (
          <div key={s} className="flex items-center gap-2">
            {/* 可访问名：勾选框与旁边的纯文本 span 未做 label 关联，
                无障碍树里原本是无名勾选框，role/name 定位（e2e、屏幕阅读器）
                都无法区分 manual 与 auto。 */}
            <Checkbox
              aria-label={`${SOURCE_LABELS[s]} source filter`}
              checked={selectedSources.includes(s)}
              onCheckedChange={() => onSourceSelect(s)}
            />
            <span className="text-sm">{SOURCE_LABELS[s]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
