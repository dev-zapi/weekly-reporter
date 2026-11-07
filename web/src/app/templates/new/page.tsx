import { Link } from 'react-router'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { TemplateForm } from '@/components/TemplateForm'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import styles from '@/components/library-configuration.module.css'

export default function NewTemplatePage() {
  const navigate = useNavigate()

  async function handleSave(data: {
    name: string
    content: string
    description?: string
    tags?: string
  }) {
    const response = await apiFetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (response.ok) {
      navigate('/templates')
    } else {
      const error = await response.json()
      toast.error((error.error || 'Creation failed') + traceSuffix(response))
      throw new Error('Creation failed')
    }
  }

  return (
    <section className={styles.surface} aria-labelledby="new-template-title">
      <Link to="/templates" className={styles.backLink}>
        <ArrowLeft size={14} aria-hidden="true" />
        Back to templates
      </Link>
      <header className={styles.pageHeading}>
        <div className={styles.headingText}>
          <h1 id="new-template-title">New Template</h1>
          <p className={styles.description}>
            Create a personal report template with reusable sections and instructions.
          </p>
        </div>
      </header>
      <div className={styles.formPanel}>
        <TemplateForm onSave={handleSave} onCancel={() => navigate('/templates')} />
      </div>
    </section>
  )
}
