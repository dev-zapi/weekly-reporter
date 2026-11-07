import { useParams, useSearchParams } from 'react-router'
import { ReportWorkspace } from '@/components/ReportWorkspace'
import type { AudienceVariant } from '@/lib/db/schema'

function parseAudience(value: string | null | undefined): AudienceVariant | undefined {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate === 'leadership' || candidate === 'personal' ? candidate : undefined
}

export default function ReportDetailPage() {
  const params = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  return (
    <ReportWorkspace
      reportId={Number.parseInt(params.id ?? '', 10)}
      editable={false}
      initialAudience={parseAudience(searchParams.get('audience'))}
    />
  )
}
