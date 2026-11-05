import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import EditCollectSourcePage from './page'
import type { FormData } from '@/components/CollectSourceForm'

const { mockApiFetch, mockPush, mockInitialData } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockPush: vi.fn(),
  mockInitialData: vi.fn(),
}))

vi.mock('@/lib/api-client', () => ({
  apiFetch: mockApiFetch,
  traceSuffix: () => '',
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/CollectSourceForm', () => ({
  CollectSourceForm: (props: { sourceId: number; initialData: FormData }) => {
    mockInitialData(props)
    return <div data-testid="source-form" />
  },
}))

const sourcePayload = {
  id: 68,
  type: 'git-local',
  name: 'hs-common-cloud-starter-parent',
  projectScope: 'work',
  enabled: true,
  config: {
    owner: '/home/god/huashang/hs-common-cloud-starter-parent',
    authorEmails: ['dev@example.com'],
    branches: [
      { name: '', lastCommitTime: '2026-09-23T05:31:53.000Z' },
      { name: 'master', lastCommitTime: '2026-09-23T05:31:53.000Z' },
    ],
  },
}

describe('/collect/[id] page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sourcePayload),
    })
  })

  it('drops the blank legacy branch placeholder instead of rendering an unnamed chip', async () => {
    render(<EditCollectSourcePage params={Promise.resolve({ id: '68' })} />)

    await screen.findByTestId('source-form')
    const { initialData } = mockInitialData.mock.calls[0][0]
    expect(initialData.config.branches).toEqual([
      { name: 'master', lastCommitTime: '2026-09-23T05:31:53.000Z' },
    ])
  })
})
