import { useEffect, useRef } from 'react'
import { ArrowLeft, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import type { AIStyleRow } from '@/lib/db/schema'
import { WorkbenchLayout } from '@/components/WorkbenchLayout'
import { TabsContent } from '@/components/ui/tabs'
import { useAIStyles } from './useAIStyles'
import { AIStylePromptPanel, AIStyleRecordDetails, aiStyleParameterLabel } from './AIStyleDetails'
import { PromptHeader, PromptTabs, type PromptTab } from './PromptChrome'
import libraryStyles from './library-configuration.module.css'
import styles from './ai-style-workbench.module.css'

export function AIStyleWorkbench({ activeTab, onTabChange }: {
  activeTab: PromptTab
  onTabChange: (tab: PromptTab) => void
}) {
  const { styles: aiStyles, loading, error, retry, remove, setDefault } = useAIStyles()
  const [searchParams, setSearchParams] = useSearchParams()
  const styleParam = searchParams.get('style')
  const selected = aiStyles.find((style) => String(style.id) === styleParam) ?? aiStyles[0]
  const promptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (loading || !aiStyles.length) return
    if (styleParam && aiStyles.some((style) => String(style.id) === styleParam)) return
    const params = new URLSearchParams(searchParams)
    params.set('tab', 'styles')
    params.set('style', String(aiStyles[0].id))
    setSearchParams(params, { replace: true })
  }, [aiStyles, loading, styleParam, searchParams, setSearchParams])

  function selectStyle(id: number) {
    const params = new URLSearchParams(searchParams)
    params.set('tab', 'styles')
    params.set('style', String(id))
    setSearchParams(params)
    if (window.matchMedia('(max-width: 960px)').matches) {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      window.requestAnimationFrame(() => promptRef.current?.scrollIntoView({ behavior, block: 'start' }))
    }
  }

  async function deleteSelected() {
    if (!selected || selected.isDefault || aiStyles.length <= 1) return
    if (!window.confirm(`Delete style “${selected.label}”?`)) return
    await remove(selected.id)
  }

  return (
    <WorkbenchLayout className={styles.page}>
      <WorkbenchLayout.Primary id="ai-style-index" className={libraryStyles.surface} aria-label="AI style management">
        <PromptHeader action={(
          <Link to="/prompts/styles/new" className={libraryStyles.primaryButton}>
            <Plus size={15} aria-hidden="true" /> New style
          </Link>
        )} />
        <PromptTabs activeTab={activeTab} onChange={onTabChange}>
          <TabsContent value="styles" className={libraryStyles.tabContent}>
            <div className={libraryStyles.indexBar}>
              <div className={libraryStyles.indexTitle}>
                <h2>AI style index</h2>
                <span className={libraryStyles.count}>{aiStyles.length} styles</span>
              </div>
            </div>

            {loading ? (
              <div className={libraryStyles.loadingState} role="status">
                <span className={libraryStyles.loadingLine} aria-hidden="true" />
                <strong>Loading AI styles…</strong>
              </div>
            ) : error ? (
              <div className={libraryStyles.errorState} role="alert">
                <strong>AI styles could not be loaded</strong>
                <p>{error}</p>
                <button type="button" className={libraryStyles.stateAction} onClick={() => void retry()}>
                  Retry loading styles
                </button>
              </div>
            ) : aiStyles.length === 0 ? (
              <div className={libraryStyles.emptyState}>
                <strong>No styles yet</strong>
                <p>Create an AI style to define the voice and generation parameters available for reports.</p>
                <Link to="/prompts/styles/new" className={libraryStyles.secondaryButton}>
                  <Plus size={15} aria-hidden="true" /> New style
                </Link>
              </div>
            ) : (
              <div className={styles.commandTable} role="group" aria-label="AI style index">
                <div className={styles.commandTableHead} aria-hidden="true">
                  <span>Reference</span><span>Style</span><span>Parameters</span><span>Edit</span>
                </div>
                {aiStyles.map((style) => (
                  <div key={style.id} className={`${styles.commandRow} ${selected?.id === style.id ? styles.selectedRow : ''}`}>
                    <button
                      type="button"
                      className={styles.commandRowSelect}
                      onClick={() => selectStyle(style.id)}
                      aria-pressed={selected?.id === style.id}
                    >
                      <span className={styles.recordRef}>S{style.id}</span>
                      <span>
                        <span className={styles.styleTitle}>
                          <strong>{style.label}</strong>
                          {style.isDefault && <span className={styles.defaultBadge}>Default</span>}
                        </span>
                        <small>{style.key}</small>
                      </span>
                      <span className={styles.parameterPair}>
                        <b>T {style.temperature}</b>
                        <small>{aiStyleParameterLabel(style.detailLevel, 'detail')}</small>
                      </span>
                    </button>
                    <Link
                      to={`/prompts/styles/${style.id}`}
                      className={libraryStyles.iconButton}
                      aria-label={`Edit style ${style.label}`}
                      title="Edit style"
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </PromptTabs>
      </WorkbenchLayout.Primary>

      <WorkbenchLayout.Rail className={styles.context} label="Selected AI style context">
        {selected ? <SelectedStyleDetails
          style={selected}
          styleCount={aiStyles.length}
          promptRef={promptRef}
          onDefault={() => void setDefault(selected.id)}
          onDelete={() => void deleteSelected()}
        /> : !loading && !error ? (
          <div className={styles.emptyRail}>Select a style to inspect its complete instruction and generation parameters.</div>
        ) : null}
      </WorkbenchLayout.Rail>
    </WorkbenchLayout>
  )
}

function SelectedStyleDetails({ style, styleCount, promptRef, onDefault, onDelete }: {
  style: AIStyleRow
  styleCount: number
  promptRef: React.RefObject<HTMLDivElement | null>
  onDefault: () => void
  onDelete: () => void
}) {
  const deleteDisabled = style.isDefault || styleCount <= 1
  const deleteReason = style.isDefault
    ? 'The default style cannot be deleted'
    : styleCount <= 1 ? 'The last style cannot be deleted' : 'Delete style'

  return (
    <>
      <a className={styles.mobileBack} href="#ai-style-index">
        <ArrowLeft size={14} aria-hidden="true" /> Back to style list
      </a>
      <AIStylePromptPanel style={style} promptRef={promptRef} />
      <section className={styles.detailsPanel} aria-labelledby="style-actions-title">
        <div className={styles.panelHeader}>
          <div><span className={styles.recordRef}>Actions</span><h2 id="style-actions-title">Change this style</h2></div>
        </div>
        <div className={styles.compactActions}>
          <Link to={`/prompts/styles/${style.id}`} className={libraryStyles.primaryButton}>
            <Pencil size={14} aria-hidden="true" /> Edit style
          </Link>
          <button type="button" className={libraryStyles.secondaryButton} onClick={onDefault} disabled={style.isDefault}>
            <Star size={14} aria-hidden="true" /> {style.isDefault ? 'Current default' : 'Set as default'}
          </button>
          <button
            type="button"
            className={`${libraryStyles.secondaryButton} ${libraryStyles.dangerButton}`}
            onClick={onDelete}
            disabled={deleteDisabled}
            title={deleteReason}
          >
            <Trash2 size={14} aria-hidden="true" /> Delete
          </button>
        </div>
      </section>
      <section className={styles.detailsPanel} aria-labelledby="style-record-title">
        <div className={styles.panelHeader}>
          <div><span className={styles.recordRef}>S{style.id}</span><h2 id="style-record-title">Generation record</h2></div>
          {style.isDefault && <span className={styles.defaultBadge}>Default</span>}
        </div>
        <AIStyleRecordDetails style={style} />
      </section>
    </>
  )
}
