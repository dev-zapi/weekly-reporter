'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { getSectionStatus, parseSections } from '@/lib/utils'
import { CheckCircle, AlertCircle, XCircle } from 'lucide-react'

interface CheckPanelProps {
  content: string
}

export function CheckPanel({ content }: CheckPanelProps) {
  const [status, setStatus] = useState<Record<string, 'empty' | 'short' | 'good'>>({})
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([])

  useEffect(() => {
    setStatus(getSectionStatus(content))
  }, [content])

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (content.trim().length < 50) {
        setAiSuggestions([])
        return
      }

      try {
        const response = await apiFetch('/api/reports/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        const data = await response.json()
        setAiSuggestions(data.suggestions || [])
      } catch (error) {
        setAiSuggestions([])
      }
    }, 2000)

    return () => clearTimeout(timer)
  }, [content])

  const sections = parseSections(content)

  return (
    <div className="space-y-4 p-4 border rounded-lg">
      <div className="font-medium">Completion</div>
      
      <div className="space-y-2">
        {Object.entries(sections).map(([name, sectionContent]) => {
          const sectionStatus = status[name] || 'empty'
          const Icon = sectionStatus === 'good' ? CheckCircle : 
                       sectionStatus === 'short' ? AlertCircle : XCircle
          const color = sectionStatus === 'good' ? 'text-green-500' :
                        sectionStatus === 'short' ? 'text-yellow-500' : 'text-red-500'
          
          return (
            <div key={name} className="flex items-center gap-2">
              <Icon className={`h-4 w-4 ${color}`} />
              <span className="text-sm">{name}</span>
              {sectionStatus === 'short' && (
                <span className="text-xs text-muted-foreground">Consider adding more detail</span>
              )}
              {sectionStatus === 'empty' && (
                <span className="text-xs text-muted-foreground">Empty</span>
              )}
            </div>
          )
        })}
      </div>

      {aiSuggestions.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium">AI suggestions</div>
          <div className="space-y-1">
            {aiSuggestions.map((suggestion, index) => (
              <div key={index} className="text-sm text-muted-foreground">
                • {suggestion}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
