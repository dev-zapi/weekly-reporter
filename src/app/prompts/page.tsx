'use client'

import { PromptManager } from '@/components/PromptManager'

export default function PromptsPage() {
  return (
    <div className="container mx-auto py-8 px-4 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Prompt Management</h1>
      <PromptManager />
    </div>
  )
}
