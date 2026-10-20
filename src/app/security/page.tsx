'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { Shield, Copy, Plus, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api-client'
import { formatSystemDateTime } from '@/lib/time-format'

interface PatMetadata {
  id: number
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  revokedAt: number | null
}

interface CreatedPat {
  id: number
  name: string
  token: string
  createdAt: number
}

interface AuditRecord {
  id: number
  createdAt: number
  patName: string | null
  method: string
  apiPath: string
  status: number
  userAgent: string | null
  agentIdentity: string | null
  callerCwd: string | null
  outcome: 'success' | 'unauthorized'
}

function getPatStatus(
  pat: PatMetadata,
): 'active' | 'revoked' | 'expired' {
  if (pat.revokedAt !== null) return 'revoked'
  if (pat.expiresAt !== null && pat.expiresAt < Date.now()) return 'expired'
  return 'active'
}

function formatStatus(status: 'active' | 'revoked' | 'expired'): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function statusBadgeVariant(
  status: 'active' | 'revoked' | 'expired',
): 'default' | 'secondary' | 'destructive' {
  if (status === 'active') return 'default'
  if (status === 'revoked') return 'destructive'
  return 'secondary'
}

export default function SecurityPage() {
  return (
    <main className="container mx-auto py-8 px-4 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Shield className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Security</h1>
      </div>

      <Tabs defaultValue="pats">
        <TabsList>
          <TabsTrigger value="pats">Personal Access Tokens</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="pats">
          <PatSection />
        </TabsContent>

        <TabsContent value="audit">
          <AuditSection />
        </TabsContent>
      </Tabs>
    </main>
  )
}

function PatSection() {
  const [pats, setPats] = useState<PatMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState<CreatedPat | null>(null)
  const [copied, setCopied] = useState(false)

  const loadPats = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/pats')
      const data = await res.json()
      setPats(data.pats ?? [])
    } catch (err) {
      console.error('Failed to load PATs:', err)
      toast.error('Failed to load PATs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPats()
  }, [loadPats])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setCreating(true)
    try {
      const body: { name: string; expiresAt?: number } = { name: name.trim() }
      if (expiresAt) {
        body.expiresAt = Math.floor(new Date(expiresAt).getTime())
      }
      const res = await apiFetch('/api/auth/pats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to create PAT')
      }
      const created: CreatedPat = await res.json()
      setJustCreated(created)
      setName('')
      setExpiresAt('')
      toast.success('PAT created')
      await loadPats()
    } catch (err) {
      console.error('Create PAT failed:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to create PAT')
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: number, patName: string) => {
    if (!confirm(`Revoke PAT "${patName}"? This cannot be undone.`)) return
    try {
      const res = await apiFetch(`/api/auth/pats/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to revoke PAT')
      }
      toast.success(`PAT "${patName}" revoked`)
      await loadPats()
    } catch (err) {
      console.error('Revoke failed:', err)
      toast.error(err instanceof Error ? err.message : 'Failed to revoke PAT')
    }
  }

  const handleCopy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      toast.success('Token copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Copy failed:', err)
      toast.error('Failed to copy token')
    }
  }

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-6 pt-4">
      <section>
        <h2 className="text-lg font-semibold mb-3">Create new token</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="text-xs text-muted-foreground mb-1 block" htmlFor="pat-name">
              Token name
            </label>
            <Input
              id="pat-name"
              placeholder="Token name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={creating}
              required
            />
          </div>
          <div className="w-[180px]">
            <label className="text-xs text-muted-foreground mb-1 block" htmlFor="pat-expires">
              Expires (optional)
            </label>
            <Input
              id="pat-expires"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={creating}
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            Create
          </Button>
        </form>
      </section>

      {justCreated && (
        <section
          className="rounded-lg border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-2"
          aria-label="Newly created token"
        >
          <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            <span>This token is only shown once — save it now.</span>
          </div>
          <div className="flex items-center gap-2">
            <code
              data-testid="new-token-value"
              className="flex-1 font-mono text-sm bg-white dark:bg-black/40 px-3 py-2 rounded border break-all"
            >
              {justCreated.token}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCopy(justCreated.token)}
              aria-label="Copy token"
            >
              <Copy className="h-4 w-4 mr-1" />
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This token cannot be viewed again. If you lose it, create a new one.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setJustCreated(null)}>
            Dismiss
          </Button>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Existing tokens</h2>
        {pats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No PATs yet. Create one above to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Prefix</th>
                  <th className="pb-2 pr-3">Created</th>
                  <th className="pb-2 pr-3">Last used</th>
                  <th className="pb-2 pr-3">Expires</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pats.map((pat) => {
                  const status = getPatStatus(pat)
                  return (
                    <tr key={pat.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{pat.name}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{pat.prefix}</td>
                      <td className="py-2 pr-3">{formatSystemDateTime(pat.createdAt)}</td>
                      <td className="py-2 pr-3">
                        {pat.lastUsedAt ? formatSystemDateTime(pat.lastUsedAt) : <span className="text-muted-foreground">Never</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {pat.expiresAt ? formatSystemDateTime(pat.expiresAt) : <span className="text-muted-foreground">Never</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={statusBadgeVariant(status)}>
                          {formatStatus(status)}
                        </Badge>
                      </td>
                      <td className="py-2">
                        {status === 'active' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevoke(pat.id, pat.name)}
                            className="text-destructive hover:text-destructive"
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function AuditSection() {
  const [records, setRecords] = useState<AuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [limit] = useState(50)
  const [offset, setOffset] = useState(0)
  const [patNameFilter, setPatNameFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const loadRecords = useCallback(
    async (currentOffset: number, patName: string, status: string) => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('limit', String(limit))
        params.set('offset', String(currentOffset))
        if (patName.trim()) params.set('patName', patName.trim())
        if (status.trim()) params.set('status', status.trim())

        const res = await apiFetch(`/api/audit?${params.toString()}`)
        const data = await res.json()
        setRecords(data.records ?? [])
        setTotal(data.total ?? 0)
      } catch (err) {
        console.error('Failed to load audit records:', err)
        toast.error('Failed to load audit log')
      } finally {
        setLoading(false)
      }
    },
    [limit],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecords(offset, patNameFilter, statusFilter)
  }, [loadRecords, offset, patNameFilter, statusFilter])

  const handleSearch = () => {
    setOffset(0)
    loadRecords(0, patNameFilter, statusFilter)
  }

  const handleNext = () => {
    if (offset + limit < total) {
      setOffset(offset + limit)
    }
  }

  const handlePrev = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit))
    }
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap gap-2 items-end">
        <div className="min-w-[160px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            PAT name
          </label>
          <Input
            placeholder="PAT name"
            value={patNameFilter}
            onChange={(e) => setPatNameFilter(e.target.value)}
          />
        </div>
        <div className="w-[100px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            Status
          </label>
          <Input
            placeholder="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        <Button onClick={handleSearch}>Search</Button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : records.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          {total === 0 ? 'No audit records found.' : 'Loading...'}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3">Time</th>
                  <th className="pb-2 pr-3">PAT name</th>
                  <th className="pb-2 pr-3">Method</th>
                  <th className="pb-2 pr-3">Path</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 pr-3">Agent</th>
                  <th className="pb-2 pr-3">CWD</th>
                  <th className="pb-2 pr-3">User-Agent</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatSystemDateTime(record.createdAt)}
                    </td>
                    <td className="py-2 pr-3">{record.patName ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{record.method}</td>
                    <td className="py-2 pr-3 font-mono text-xs break-all">{record.apiPath}</td>
                    <td className="py-2 pr-3 font-mono">{record.status}</td>
                    <td className="py-2 pr-3 text-xs">{record.agentIdentity ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="py-2 pr-3 text-xs break-all max-w-[200px]">
                      {record.callerCwd ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs break-all max-w-[200px]">
                      {record.userAgent ?? <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground pt-2">
            <span>
              {total === 0
                ? 'No records'
                : `Showing ${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={handlePrev}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + limit >= total}
                onClick={handleNext}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
