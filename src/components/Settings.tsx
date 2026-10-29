'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Settings as SettingsIcon, X, RefreshCw, TestTube } from 'lucide-react'

const DEFAULT_UI_FONT = 'system-ui, sans-serif'
const DEFAULT_EDITOR_FONT = 'Geist, sans-serif'

interface SettingsProps {
  isOpen: boolean
  onClose: () => void
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState('font')

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-lg space-y-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Settings</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
          <TabsTrigger value="font">Fonts</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
          </TabsList>

          <TabsContent value="font" className="mt-4">
            <FontSettingsTab />
          </TabsContent>

          <TabsContent value="ai" className="mt-4">
            <AISettingsTab />
          </TabsContent>
        </Tabs>

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </div>
  )
}

function FontSettingsTab() {
  const [uiFont, setUiFont] = useState(() => localStorage.getItem('ui-font') || DEFAULT_UI_FONT)
  const [editorFont, setEditorFont] = useState(() => localStorage.getItem('editor-font') || DEFAULT_EDITOR_FONT)

  useEffect(() => {
    applyFonts(uiFont, editorFont)
  }, [uiFont, editorFont])

  function applyFonts(uiFont: string, editorFont: string) {
    document.documentElement.style.setProperty('--font-ui', uiFont)
    document.documentElement.style.setProperty('--font-editor', editorFont)
  }

  function handleUiFontChange(font: string) {
    setUiFont(font)
    localStorage.setItem('ui-font', font)
    applyFonts(font, editorFont)
  }

  function handleEditorFontChange(font: string) {
    setEditorFont(font)
    localStorage.setItem('editor-font', font)
    applyFonts(uiFont, font)
  }

  function handleReset() {
    setUiFont(DEFAULT_UI_FONT)
    setEditorFont(DEFAULT_EDITOR_FONT)
    localStorage.setItem('ui-font', DEFAULT_UI_FONT)
    localStorage.setItem('editor-font', DEFAULT_EDITOR_FONT)
    applyFonts(DEFAULT_UI_FONT, DEFAULT_EDITOR_FONT)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ui-font">UI font</Label>
        <Input
          id="ui-font"
          value={uiFont}
          onChange={(e) => handleUiFontChange(e.target.value)}
          placeholder="e.g. system-ui, sans-serif"
        />
        <p className="text-xs text-muted-foreground">
          Used for UI headings, buttons, lists, and other elements. Use CSS font-family syntax.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="editor-font">Editor font</Label>
        <Input
          id="editor-font"
          value={editorFont}
          onChange={(e) => handleEditorFontChange(e.target.value)}
          placeholder="e.g. Geist, sans-serif"
        />
        <p className="text-xs text-muted-foreground">
          Used for Markdown editor content. Use CSS font-family syntax.
        </p>
      </div>

      <Button variant="outline" onClick={handleReset}>
        Reset defaults
      </Button>
    </div>
  )
}

function AISettingsTab() {
  const [protocol, setProtocol] = useState<'openai' | 'openai-compatible' | 'anthropic'>('openai-compatible')
  const [apiUrl, setApiUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false)
  const [model, setModel] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings/ai')
      const data = await res.json()
      if (data.configured) {
        setProtocol(data.protocol)
        setApiUrl(data.apiUrl)
        setApiKey('')
        setApiKeyConfigured(data.apiKeyConfigured ?? false)
        setModel(data.model)
        if (data.modelListCache) {
          setAvailableModels(data.modelListCache)
        }
      }
    } catch (error) {
      console.error('Failed to load AI config:', error)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadConfig()
  }, [loadConfig])

  async function handleSave() {
    setLoading(true)
    setSaved(false)
    setSaveError(null)
    try {
      const res = await apiFetch('/api/settings/ai', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol, apiUrl, apiKey, model }),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        await loadConfig()
      } else {
        const data = await res.json().catch(() => ({ error: 'Save failed' }))
        setSaveError((data.error ?? 'Save failed') + traceSuffix(res))
      }
    } catch (error) {
      console.error('Failed to save AI config:', error)
      setSaveError('Network error. Check your connection.')
    } finally {
      setLoading(false)
    }
  }

  async function handleFetchModels() {
    if (!apiUrl) return
    setLoading(true)
    try {
      let res
      if (apiKey) {
        res = await apiFetch('/api/settings/ai/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol, apiUrl, apiKey }),
        })
      } else {
        res = await apiFetch('/api/settings/ai/models')
      }
      const data = await res.json()
      if (data.models && data.models.length > 0) {
        setAvailableModels(data.models)
      }
    } catch (error) {
      console.error('Failed to fetch models:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      if (apiKey) {
        await handleSave()
      }
      const res = await apiFetch('/api/settings/ai/test', { method: 'POST' })
      const data = await res.json()
      setTestResult({
        ok: data.ok,
        error: data.error
          ? data.error + (data.ok ? '' : traceSuffix(res))
          : data.error,
      })
    } catch (error) {
      setTestResult({ ok: false, error: String(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Protocol</Label>
        <Select value={protocol} onValueChange={(v) => setProtocol(v as 'openai' | 'openai-compatible' | 'anthropic')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            <SelectItem value="openai-compatible">OpenAI Compatible</SelectItem>
            <SelectItem value="anthropic">Anthropic</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          OpenAI Compatible supports compatible APIs such as Qwen and DeepSeek.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="api-url">API URL</Label>
        <Input
          id="api-url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder={protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="api-key">API Key</Label>
        <Input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="space-y-2 relative z-1">
        <Label>Model</Label>
        <div className="flex gap-2">
          <div className="flex-1">
            <Select value={model} onValueChange={(v) => setModel(v as string)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model or enter one manually" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.length === 0 ? (
                  <SelectItem value="__placeholder__" disabled>
                    No models available
                  </SelectItem>
                ) : (
                  availableModels.map(m => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          {protocol === 'openai' && (
            <Button
              variant="outline"
              size="icon"
              onClick={handleFetchModels}
              disabled={loading || !apiUrl || (!apiKey && !apiKeyConfigured)}
              title="Refresh model list"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </div>
        {protocol === 'openai' && availableModels.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Click refresh to fetch models, or enter a model name manually.
          </p>
        )}
        {protocol === 'anthropic' && (
          <p className="text-xs text-muted-foreground">
            Anthropic does not support automatic model fetching. Enter a model name manually (for example, claude-sonnet-4-20250514).
          </p>
        )}
        <Input
          value={model === '__placeholder__' ? '' : model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Or enter a model name manually"
          className="mt-2"
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={loading}>
          {loading ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}
        </Button>
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !apiUrl || !model || (!apiKey && !apiKeyConfigured)}
        >
          {testing ? (
            <>
              <TestTube className="h-4 w-4 mr-2 animate-pulse" />
              Testing...
            </>
          ) : (
            <>
              <TestTube className="h-4 w-4 mr-2" />
              Test connection
            </>
          )}
        </Button>
      </div>

      {saveError && (
        <div className="text-sm text-red-600">
          ✗ Save failed: {saveError}
        </div>
      )}

      {testResult && (
        <div className={`text-sm ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
          {testResult.ok ? '✓ Connected' : `✗ Connection failed: ${testResult.error}`}
        </div>
      )}
    </div>
  )
}

export function SettingsButton() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setIsOpen(true)}>
        <SettingsIcon className="h-4 w-4" />
      </Button>
      <Settings isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  )
}
