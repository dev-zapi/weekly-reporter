'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { TemplateForm } from '@/components/TemplateForm'
import { toast } from 'sonner'

export default function NewTemplatePage() {
  const router = useRouter()

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
      router.push('/templates')
    } else {
      const error = await response.json()
      toast.error((error.error || 'Creation failed') + traceSuffix(response))
      throw new Error('Creation failed')
    }
  }

  return (
    <main className="container mx-auto py-8 px-4 max-w-3xl">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/templates">
          <Button variant="ghost" size="icon">←</Button>
        </Link>
        <h1 className="text-2xl font-bold">New Template</h1>
      </div>

      <TemplateForm onSave={handleSave} onCancel={() => router.push('/templates')} />
    </main>
  )
}
