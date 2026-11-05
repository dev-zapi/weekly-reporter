'use client'

import { PromptManager } from '@/components/PromptManager'
import styles from '@/components/library-configuration.module.css'

export default function PromptsPage() {
  return (
    <section className={styles.surface} aria-labelledby="prompt-library-title">
      <header className={styles.pageHeading}>
        <div className={styles.headingText}>
          <h1 id="prompt-library-title">Prompt Management</h1>
          <p className={styles.description}>
            Maintain reusable AI writing styles and the system prompts used for writing suggestions and final report generation.
          </p>
        </div>
      </header>
      <PromptManager />
    </section>
  )
}
