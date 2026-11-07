import { Link } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { CollectSourceForm } from '@/components/CollectSourceForm'
import styles from '@/components/collection-sources.module.css'

export default function NewCollectSourcePage() {
  return (
    <div className={styles.surface}>
      <div className={styles.formPrimary}>
        <div className={styles.formLayout}>
          <header className={styles.pageHeading}>
            <div className={styles.headingText}>
              <h1>New source</h1>
              <p className={styles.description}>
                Connect a local or remote Git repository and define which authors, branches, and report scope it belongs to.
              </p>
            </div>
            <Link to="/collect" className={styles.secondaryButton}>
              <ArrowLeft size={16} aria-hidden="true" />
              Collection sources
            </Link>
          </header>
          <CollectSourceForm />
        </div>
      </div>
    </div>
  )
}
