'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { TemplateList } from '@/components/TemplateList'
import styles from '@/components/library-configuration.module.css'

export default function TemplatesPage() {
  return (
    <section className={styles.surface} aria-labelledby="template-library-title">
      <header className={styles.pageHeading}>
        <div className={styles.headingText}>
          <h1 id="template-library-title">Template Management</h1>
          <p className={styles.description}>
            Browse official templates, maintain personal copies, and prepare the structure used for report generation.
          </p>
        </div>
        <Link href="/templates/new" className={styles.primaryButton}>
          <Plus size={16} aria-hidden="true" />
          New template
        </Link>
      </header>
      <TemplateList />
    </section>
  )
}
