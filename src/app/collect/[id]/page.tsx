'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { CollectSourceForm } from '@/components/CollectSourceForm'
import type { FormData, BranchFormValue } from '@/components/CollectSourceForm'
import { toast } from 'sonner'
import styles from '@/components/collection-sources.module.css'

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
            ? data.config.branches
              .map((b: string | BranchFormValue) => typeof b === 'string' ? { name: b, lastCommitTime: null } : { name: b.name, lastCommitTime: b.lastCommitTime || null })
              // Blank names are the legacy "all branches" placeholder, not an
              // editable branch: rendering one produces an unnamed chip.
              .filter((branch: BranchFormValue) => branch.name.trim() !== '')
            : [],
          authorEmails: Array.isArray(data.config.authorEmails) ? data.config.authorEmails.join(',') : '',
        },
        enabled: data.enabled,
      })
    } catch {
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

  const heading = id ? `Edit source #${id}` : 'Edit source'

  return (
    <div className={styles.surface}>
      <div className={styles.formPrimary}>
        <div className={styles.formLayout}>
          <header className={styles.pageHeading}>
            <div className={styles.headingText}>
              <h1>{heading}</h1>
              <p className={styles.description}>
                Update repository access, author identities, branch configuration, and report scope without changing its collection history.
              </p>
            </div>
            <Link href="/collect" className={styles.secondaryButton}>
              <ArrowLeft size={16} aria-hidden="true" />
              Collection sources
            </Link>
          </header>

          {loading ? (
            <div className={styles.loadingState} role="status" aria-live="polite">
              <span className={styles.loadingLine} aria-hidden="true" />
              <span>Loading source configuration…</span>
            </div>
          ) : id && initialData ? (
            <CollectSourceForm sourceId={id} initialData={initialData} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
