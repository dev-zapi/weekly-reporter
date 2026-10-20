import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { fetchLocalSource } from '@/lib/collect/git-local-fetch'
import { SourceOperationBusyError } from '@/lib/collect/source-operation-lock'

export const POST = withAuth(async function POST(request: Request) {
  try {
    const body = await request.json()
    const sourceId = Number(body?.sourceId)

    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return NextResponse.json(
        { error: '无效的采集源ID', code: 'INVALID_ID' },
        { status: 400 },
      )
    }

    const result = await fetchLocalSource(sourceId)
    if (result.status === 'failed') {
      const status = result.error === '采集源不存在'
        ? 404
        : result.error === '仅支持本地 Git 来源'
        ? 400
        : 500
      return NextResponse.json(
        { error: result.error, code: 'FETCH_FAILED', result },
        { status },
      )
    }

    return NextResponse.json({ result })
  } catch (error) {
    if (error instanceof SourceOperationBusyError) {
      return NextResponse.json(
        { error: '该仓库正在操作中，请稍后重试', code: 'SOURCE_BUSY' },
        { status: 409 },
      )
    }

    return NextResponse.json(
      { error: '仓库 Fetch 失败', code: 'FETCH_ERROR' },
      { status: 500 },
    )
  }
})
