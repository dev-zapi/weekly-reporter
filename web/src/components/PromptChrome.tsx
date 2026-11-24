import type { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import libraryStyles from './library-configuration.module.css'

export type PromptTab = 'styles' | 'system'

export function PromptHeader({ action }: { action?: ReactNode }) {
  return (
    <header className={libraryStyles.pageHeading}>
      <div className={libraryStyles.headingText}>
        <h1 id="prompt-library-title">Prompt Management</h1>
        <p className={libraryStyles.description}>
          Maintain reusable AI writing styles and the system prompts used for writing suggestions and final report generation.
        </p>
      </div>
      {action}
    </header>
  )
}

export function PromptTabs({ activeTab, onChange, children }: {
  activeTab: PromptTab
  onChange: (tab: PromptTab) => void
  children?: ReactNode
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onChange(value as PromptTab)}
      className={libraryStyles.tabs}
    >
      <TabsList className={libraryStyles.tabsList} aria-label="Prompt configuration">
        <TabsTrigger value="styles" className={libraryStyles.tabTrigger}>Style management</TabsTrigger>
        <TabsTrigger value="system" className={libraryStyles.tabTrigger}>System prompts</TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  )
}
