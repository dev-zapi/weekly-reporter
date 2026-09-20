import { describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { reportVariants, reports } from '@/lib/db/schema'
import { createCarryForwardSnapshot, normalizeCarryForwardSnapshot } from './carry-forward'

describe('carry-forward snapshots', () => {
  it('captures only the exact previous cycle and keeps audience-specific candidates stable', async () => {
    const db = getDb()
    const now = new Date()
    const marker = `carry-forward-${Date.now()}`
    const previous = db.insert(reports).values({
      title: `${marker} previous`, content: 'legacy content', weekStart: '2027-01-04', weekEnd: '2027-01-10',
      createdAt: now, updatedAt: now,
    }).returning().get()
    const target = db.insert(reports).values({
      title: `${marker} target`, content: 'target content', weekStart: '2027-01-11', weekEnd: '2027-01-17',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values([
      { reportId: previous.id, variant: 'leadership' as const, sourceDraft: 'source', finalContent: `## 下周计划\n- ${marker} leadership`, finalStatus: 'current' as const, acceptedProposalId: 1, sourceRevision: 1 as const, createdAt: now, updatedAt: now },
      { reportId: previous.id, variant: 'personal' as const, sourceDraft: 'source', finalContent: `## 下周计划\n- ${marker} personal`, finalStatus: 'current' as const, acceptedProposalId: 2, sourceRevision: 1 as const, createdAt: now, updatedAt: now },
    ]).run()

    const snapshot = await createCarryForwardSnapshot(target, 'personal', now)
    expect(snapshot.status).toBe('found')
    expect(snapshot.source).toMatchObject({ reportId: previous.id, audience: 'personal', finalStatus: 'current' })
    expect(snapshot.planText).toContain(`${marker} personal`)
    expect(snapshot.candidates).toHaveLength(1)
    expect(snapshot.candidates[0]).toMatchObject({ source: 'carry-forward', text: `${marker} personal` })
    expect(snapshot.candidates[0].candidateId).toMatch(/^carry-forward-/)
    expect(snapshot.candidates[0].candidateId).toBe((await createCarryForwardSnapshot(target, 'personal', now)).candidates[0].candidateId)

    db.delete(reportVariants).where(inArray(reportVariants.reportId, [previous.id, target.id])).run()
    db.delete(reports).where(inArray(reports.id, [previous.id, target.id])).run()
  })

  it('records an explicit empty snapshot and never backfills an older cycle', async () => {
    const db = getDb()
    const now = new Date()
    const marker = `carry-forward-empty-${Date.now()}`
    const older = db.insert(reports).values({
      title: `${marker} older`, content: 'older content', weekStart: '2026-12-21', weekEnd: '2026-12-27',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values({
      reportId: older.id, variant: 'personal' as const, sourceDraft: 'source', finalContent: '## 下周计划\n- must not backfill', finalStatus: 'current' as const, acceptedProposalId: 3, sourceRevision: 1 as const, createdAt: now, updatedAt: now,
    }).run()
    const target = db.insert(reports).values({
      title: `${marker} target`, content: 'target content', weekStart: '2027-01-11', weekEnd: '2027-01-17',
      createdAt: now, updatedAt: now,
    }).returning().get()

    const snapshot = await createCarryForwardSnapshot(target, 'personal', now)
    expect(snapshot).toMatchObject({ status: 'no-source', source: null, candidates: [], planText: null })
    expect(normalizeCarryForwardSnapshot(null).status).toBe('no-snapshot')

    db.delete(reportVariants).where(inArray(reportVariants.reportId, [older.id, target.id])).run()
    db.delete(reports).where(inArray(reports.id, [older.id, target.id])).run()
  })

  it('preserves source metadata while recording no-plan and parse-failed reasons', async () => {
    const db = getDb()
    const now = new Date()
    const marker = `carry-forward-state-${Date.now()}`
    const previous = db.insert(reports).values({
      title: `${marker} previous`, content: 'content', weekStart: '2027-01-04', weekEnd: '2027-01-10',
      createdAt: now, updatedAt: now,
    }).returning().get()
    const emptyTarget = db.insert(reports).values({
      title: `${marker} empty target`, content: 'content', weekStart: '2027-01-11', weekEnd: '2027-01-17',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values({
      reportId: previous.id, variant: 'personal' as const, sourceDraft: 'source', finalContent: `## 下周计划\n\n## 其他\n- ${marker} ignored`, finalStatus: 'current' as const, acceptedProposalId: 4, sourceRevision: 1 as const, createdAt: now, updatedAt: now,
    }).run()
    const emptySnapshot = await createCarryForwardSnapshot(emptyTarget, 'personal', now)
    expect(emptySnapshot).toMatchObject({ status: 'no-plan', parseStatus: 'empty', source: { reportId: previous.id }, candidates: [] })

    const failedPrevious = db.insert(reports).values({
      title: `${marker} failed previous`, content: 'content', weekStart: '2027-02-01', weekEnd: '2027-02-07',
      createdAt: now, updatedAt: now,
    }).returning().get()
    const failedTarget = db.insert(reports).values({
      title: `${marker} failed target`, content: 'content', weekStart: '2027-02-08', weekEnd: '2027-02-14',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values({
      reportId: failedPrevious.id, variant: 'personal' as const, sourceDraft: 'source', finalContent: `## 下周计划\n${marker} prose only`, finalStatus: 'current' as const, acceptedProposalId: 5, sourceRevision: 1 as const, createdAt: now, updatedAt: now,
    }).run()
    const failedSnapshot = await createCarryForwardSnapshot(failedTarget, 'personal', now)
    expect(failedSnapshot).toMatchObject({ status: 'parse-failed', parseStatus: 'failed', source: { reportId: failedPrevious.id }, candidates: [] })
    expect(failedSnapshot.planText).toContain(`${marker} prose only`)

    db.delete(reportVariants).where(inArray(reportVariants.reportId, [previous.id, emptyTarget.id, failedPrevious.id, failedTarget.id])).run()
    db.delete(reports).where(inArray(reports.id, [previous.id, emptyTarget.id, failedPrevious.id, failedTarget.id])).run()
  })

  it('uses a current final without acceptedProposalId as a carry-forward source', async () => {
    const db = getDb()
    const now = new Date()
    const marker = `carry-forward-no-proposal-${Date.now()}`
    const previous = db.insert(reports).values({
      title: `${marker} previous`, content: 'content', weekStart: '2027-03-01', weekEnd: '2027-03-07',
      createdAt: now, updatedAt: now,
    }).returning().get()
    const target = db.insert(reports).values({
      title: `${marker} target`, content: 'content', weekStart: '2027-03-08', weekEnd: '2027-03-14',
      createdAt: now, updatedAt: now,
    }).returning().get()
    db.insert(reportVariants).values({
      reportId: previous.id, variant: 'leadership' as const, sourceDraft: 'source', finalContent: `## 下周计划\n- ${marker} external-agent`, finalStatus: 'current' as const, acceptedProposalId: null, sourceRevision: 1 as const, createdAt: now, updatedAt: now,
    }).run()

    const snapshot = await createCarryForwardSnapshot(target, 'leadership', now)
    expect(snapshot.status).toBe('found')
    expect(snapshot.source).toMatchObject({ reportId: previous.id, audience: 'leadership', finalStatus: 'current', acceptedProposalId: null })
    expect(snapshot.planText).toContain(`${marker} external-agent`)
    expect(snapshot.candidates).toHaveLength(1)
    expect(snapshot.candidates[0]).toMatchObject({ source: 'carry-forward', text: `${marker} external-agent` })

    db.delete(reportVariants).where(inArray(reportVariants.reportId, [previous.id, target.id])).run()
    db.delete(reports).where(inArray(reports.id, [previous.id, target.id])).run()
  })
})
