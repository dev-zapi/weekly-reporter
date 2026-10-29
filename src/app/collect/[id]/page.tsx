'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CollectSourceForm } from '@/components/CollectSourceForm'
import type { FormData, BranchFormValue } from '@/components/CollectSourceForm'
import { toast } from 'sonner'

export default function EditCollectSourcePage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter()
  const [id, setId] = useState<number | null>(null)
  const [initialData, setInitialData] = useState<FormData | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSource = useCallback(async (sourceId: number) => {
    try {
      const res = await apiFetch(`/api/collect/sources/${sourceId}`)
      const data = await res.json()
      
      if (!res.ok) {
        toast.error((data.error || 'Failed to load source') + traceSuffix(res))
        router.push('/collect')
        return
      }
      
      setInitialData({
        type: data.type,
        name: data.name,
        projectScope: data.projectScope || 'personal',
        aliases: Array.isArray(data.config.aliases) ? data.config.aliases : [],
        config: {
          baseUrl: data.config.baseUrl || '',
          owner: data.config.owner,
          repo: data.config.repo || '',
          token: '',
          branches: Array.isArray(data.config.branches)
            ? data.config.branches.map((b: string | BranchFormValue) => typeof b === 'string' ? { name: b, lastCommitTime: null } : { name: b.name, lastCommitTime: b.lastCommitTime || null })
            : [],
          authorEmails: Array.isArray(data.config.authorEmails) ? data.config.authorEmails.join(',') : '',
        },
        enabled: data.enabled,
      })
    } catch (error) {
      toast.error('Failed to load source')
      router.push('/collect')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    params.then(p => {
      const sourceId = parseInt(p.id)
      if (isNaN(sourceId)) {
        toast.error('Invalid source ID')
        router.push('/collect')
        return
      }
      setId(sourceId)
      void fetchSource(sourceId)
    })
  }, [params, router, fetchSource])

  if (loading) {
    return (
      <main className="container mx-auto py-8 px-4 max-w-2xl">
        <div className="text-center">Loading...</div>
      </main>
    )
  }

  if (!id || !initialData) {
    return null
  }

  return (
    <main className="container mx-auto py-8 px-4 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Edit Source</h1>
      <CollectSourceForm sourceId={id} initialData={initialData} />
    </main>
  )
}
