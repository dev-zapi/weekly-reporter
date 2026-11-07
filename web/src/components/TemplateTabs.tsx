import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OfficialTemplateCard } from '@/components/OfficialTemplateCard'
import { UserTemplateCard } from '@/components/UserTemplateCard'
import type { OfficialTemplate } from '@/lib/official-templates'
import type { Template } from '@/lib/db/schema'
import styles from './library-configuration.module.css'

interface TemplateTabsProps {
  officialTemplates: OfficialTemplate[]
  userTemplates: Template[]
  onCloneOfficial: (templateId: string) => void
  onSaveAsOfficial: (templateId: string) => void
  onViewOfficial: (templateId: string) => void
  onDeleteUser: (id: number) => void
  onSelectUser?: (template: Template) => void
}

export function TemplateTabs({
  officialTemplates,
  userTemplates,
  onCloneOfficial,
  onSaveAsOfficial,
  onViewOfficial,
  onDeleteUser,
  onSelectUser,
}: TemplateTabsProps) {
  return (
    <Tabs defaultValue="official" className={styles.tabs}>
      <div className={styles.indexBar}>
        <TabsList className={styles.tabsList} aria-label="Template collections">
          <TabsTrigger value="official" className={styles.tabTrigger}>
            <span>Official templates</span>
            <span className={styles.tabCount}>{officialTemplates.length}</span>
          </TabsTrigger>
          <TabsTrigger value="user" className={styles.tabTrigger}>
            <span>Personal templates</span>
            <span className={styles.tabCount}>{userTemplates.length}</span>
          </TabsTrigger>
        </TabsList>
        <Link to="/templates/new" className={styles.secondaryButton}>
          <Plus size={15} aria-hidden="true" />
          New personal template
        </Link>
      </div>

      <TabsContent value="official" className={styles.tabContent}>
        {officialTemplates.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No official templates</strong>
            <p>The official template collection is currently empty.</p>
          </div>
        ) : (
          <div className={styles.recordList}>
            {officialTemplates.map((template) => (
              <OfficialTemplateCard
                key={template.id}
                template={template}
                onClone={onCloneOfficial}
                onSaveAs={onSaveAsOfficial}
                onView={onViewOfficial}
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="user" className={styles.tabContent}>
        {userTemplates.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No personal templates</strong>
            <p>Clone an official template or create a personal template to begin customizing your reports.</p>
            <Link to="/templates/new" className={styles.secondaryButton}>
              <Plus size={15} aria-hidden="true" />
              New personal template
            </Link>
          </div>
        ) : (
          <div className={styles.recordList}>
            {userTemplates.map((template) => (
              <UserTemplateCard
                key={template.id}
                template={template}
                onDelete={onDeleteUser}
                onUse={onSelectUser}
              />
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
