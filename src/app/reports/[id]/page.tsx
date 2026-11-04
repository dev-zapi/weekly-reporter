import { ReportWorkspace } from '@/components/ReportWorkspace'
import type { AudienceVariant } from '@/lib/db/schema'

function parseAudience(value: string | string[] | undefined): AudienceVariant | undefined {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate === 'leadership' || candidate === 'personal' ? candidate : undefined
}

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  return (
    <ReportWorkspace
      reportId={Number.parseInt(id, 10)}
      editable={false}
      initialAudience={parseAudience(query.audience)}
    />
  )
}
