'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Scan, FolderGit2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { scanRepos, batchAddSources } from '@/app/collect/actions'

interface DirectoryItem {
  name: string
  path: string
}

interface FoundRepo {
  path: string
  name: string
  alreadyAdded: boolean
  authorEmails: string[]
}

export function ScanReposDialog({
  open,
  onClose,
  onSuccess
}: {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [step, setStep] = useState<'scan' | 'result'>('scan')
  const [path, setPath] = useState('')
  const [suggestions, setSuggestions] = useState<DirectoryItem[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [repos, setRepos] = useState<FoundRepo[]>([])
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  
  const inputRef = useRef<HTMLInputElement>(null)
  
  useEffect(() => {
    if (open) {
      setStep('scan')
      setPath('')
      setSuggestions([])
      setShowSuggestions(false)
      setRepos([])
      setSelectedRepos(new Set())
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSuggestions) {
          setShowSuggestions(false)
          setActiveIndex(-1)
        } else {
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, showSuggestions, onClose])
  
  const [activeIndex, setActiveIndex] = useState(-1)
  
  const fetchSuggestions = useCallback(async (currentPath: string) => {
    try {
      setFetchError(null)
      const res = await apiFetch(`/api/collect/scan-path?path=${encodeURIComponent(currentPath)}`)
      const data = await res.json()

      if (data.error) {
        setSuggestions([])
        setShowSuggestions(false)
        setFetchError(data.error)
        return
      }

      setSuggestions(data.directories || [])
      setShowSuggestions(true)
      setActiveIndex(-1)
    } catch (error) {
      setSuggestions([])
      setShowSuggestions(false)
      setFetchError('Network error. Unable to load directory list.')
    }
  }, [])
  
  useEffect(() => {
    if (path.length > 0) {
      const timer = setTimeout(() => fetchSuggestions(path), 200)
      return () => clearTimeout(timer)
    } else {
      setSuggestions([])
      setShowSuggestions(false)
    }
  }, [path, fetchSuggestions])
  
  function handleSuggestionClick(suggestion: DirectoryItem) {
    setPath(suggestion.path)
    setShowSuggestions(false)
    setActiveIndex(-1)
    inputRef.current?.focus()
  }
  
  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showSuggestions || suggestions.length === 0) return
    
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => (prev - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      handleSuggestionClick(suggestions[activeIndex])
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const target = activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0]
      handleSuggestionClick(target)
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setActiveIndex(-1)
    }
  }
  
  async function handleScan() {
    if (!path.trim()) {
      toast.error('Please enter a path')
      return
    }
    
    setScanning(true)
    try {
      const result = await scanRepos(path, 3)
      
      if (result.error) {
        toast.error(result.error)
        setScanning(false)
        return
      }
      
      if (result.repos.length === 0) {
      toast.info('No Git repositories found')
        setScanning(false)
        return
      }
      
      setRepos(result.repos.map(repo => ({
        ...repo,
        authorEmails: [],
      })))
      setStep('result')
      toast.success(`Found ${result.repos.length} Git repositories`)
    } catch (error) {
      toast.error('Scan failed')
    } finally {
      setScanning(false)
    }
  }
  
  function handleToggleRepo(repoPath: string) {
    const newSelected = new Set(selectedRepos)
    if (newSelected.has(repoPath)) {
      newSelected.delete(repoPath)
    } else {
      newSelected.add(repoPath)
    }
    setSelectedRepos(newSelected)
  }

  function handleSelectAll() {
    const selectable = repos.filter(r => !r.alreadyAdded)
    const allSelected = selectable.every(r => selectedRepos.has(r.path))
    if (allSelected) {
      setSelectedRepos(new Set())
    } else {
      setSelectedRepos(new Set(selectable.map(r => r.path)))
    }
  }
  
  async function handleBatchAdd() {
    const selected = repos.filter(r => selectedRepos.has(r.path))
    
    if (selected.length === 0) {
      toast.error('Select repositories to add')
      return
    }
    
    setAdding(true)
    try {
      const result = await batchAddSources(selected)
      
      if (result.success) {
        toast.success(result.addedCount > 0 ? `Created ${result.addedCount} sources` : 'Nothing to add')
        onSuccess()
        onClose()
      } else {
        toast.error(result.error || 'Add failed')
      }
    } catch (error) {
      toast.error('Add failed')
    } finally {
      setAdding(false)
    }
  }
  
  if (!open) return null
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-3xl mx-4 overflow-visible">
        {step === 'scan' && (
          <>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderGit2 className="h-5 w-5" />
                Scan Git repositories
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Directory to scan</label>
                <div className="relative">
                  <Input
                    ref={inputRef}
                    type="text"
                    value={path}
                    onChange={e => setPath(e.target.value)}
                    onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                    onKeyDown={handleKeyDown}
                    placeholder="/home/user/projects"
                    disabled={scanning}
                  />
                  {showSuggestions && suggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-popover text-popover-foreground border border-input rounded-md shadow-lg max-h-48 overflow-y-auto z-10">
                      {suggestions.map((suggestion, index) => (
                        <div
                          key={suggestion.path}
                          onClick={() => handleSuggestionClick(suggestion)}
                          className={`px-3 py-2 cursor-pointer text-sm ${
                            index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                          }`}
                        >
                          <span className="font-medium">{suggestion.name}</span>
                          <span className="text-xs text-muted-foreground ml-2 truncate">{suggestion.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {fetchError && (
                  <p className="text-xs text-destructive">{fetchError}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Enter a path to see subdirectory suggestions. Fuzzy search and paths beginning with ~ are supported (for example, ~/git).
                </p>
              </div>
            </CardContent>
            <CardFooter className="gap-2">
              <Button onClick={handleScan} disabled={scanning || !path.trim()}>
                {scanning ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Scan className="h-4 w-4 mr-2" />
                    Scan
                  </>
                )}
              </Button>
              <Button variant="outline" onClick={onClose} disabled={scanning}>
                Cancel
              </Button>
            </CardFooter>
          </>
        )}
        
        {step === 'result' && (
          <>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Scan results <span className="text-sm font-normal text-muted-foreground">— {repos.length} repositories found</span></CardTitle>
            </CardHeader>
            <CardContent className="pb-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-[55vh] overflow-y-auto pr-1">
                {repos.map(repo => (
                  <label
                    key={repo.path}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer text-sm transition-colors ${
                      repo.alreadyAdded ? 'bg-muted opacity-50 cursor-not-allowed' : 'bg-background hover:bg-muted/50'
                    } ${selectedRepos.has(repo.path) ? 'ring-1 ring-primary border-primary/30 bg-primary/5' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedRepos.has(repo.path)}
                      onChange={() => handleToggleRepo(repo.path)}
                      disabled={repo.alreadyAdded}
                      className="shrink-0 rounded border-input"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-xs truncate leading-tight">
                        {repo.name}
                        {repo.alreadyAdded && <span className="text-muted-foreground font-normal ml-1">(Added)</span>}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate leading-tight">{repo.path}</p>
                    </div>
                  </label>
                ))}
              </div>
            </CardContent>
            <CardFooter className="gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={handleSelectAll}>
                {repos.filter(r => !r.alreadyAdded).every(r => selectedRepos.has(r.path)) && repos.some(r => !r.alreadyAdded)
                  ? 'Clear all' : 'Select all'}
              </Button>
              <div className="flex-1" />
              <Button size="sm" onClick={handleBatchAdd} disabled={adding || selectedRepos.size === 0}>
                {adding ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  `Add selected (${selectedRepos.size})`
                )}
              </Button>
              <Button size="sm" variant="outline" onClick={onClose} disabled={adding}>
                Cancel
              </Button>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  )
}
