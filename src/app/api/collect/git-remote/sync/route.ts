import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { syncSource, syncAllSources } from '@/lib/collect/sync'
import { SourceOperationBusyError } from '@/lib/collect/source-operation-lock'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const { sourceId, resync } = body

    if (sourceId) {
      const sourceIdNum = parseInt(sourceId)
      if (isNaN(sourceIdNum)) {
        return NextResponse.json(
          { error: '无效的采集源ID', code: 'INVALID_ID' },
          { status: 400 }
        )
      }

      const result = await syncSource(sourceIdNum, resync)

      if (result.status === 'failed') {
        return NextResponse.json(
          { error: result.error, code: 'SYNC_FAILED', result },
          { status: 500 }
        )
      }

      return NextResponse.json({ result })
    } else {
      const results = await syncAllSources(resync)

      const failed = results.filter(r => r.status === 'failed')
      if (failed.length > 0) {
        return NextResponse.json(
          {
            error: '部分采集源同步失败',
            code: 'PARTIAL_SYNC_FAILED',
            results,
            failedCount: failed.length,
          },
          { status: 500 }
        )
      }

      return NextResponse.json({ results })
    }
  } catch (error) {
    if (error instanceof SourceOperationBusyError) {
      return NextResponse.json(
        { error: '该仓库正在操作中，请稍后重试', code: 'SOURCE_BUSY' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: '同步失败', code: 'SYNC_ERROR' },
      { status: 500 }
    )
  }
})
