import { describe, it, expect, vi } from 'vitest'
import { syncEventPlanReferences, deleteEventPlanReferences } from './db'

describe('plan-references/db', () => {
  const createMockTx = () => {
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        run: vi.fn(),
      }),
    })
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        run: vi.fn(),
      }),
    })
    return { delete: mockDelete, insert: mockInsert }
  }

  describe('syncEventPlanReferences', () => {
    it('should delete existing references and insert new ones', () => {
      const tx = createMockTx()
      const eventId = 42
      const planItemIds = [1, 2, 3]

      syncEventPlanReferences(tx as any, eventId, planItemIds)

      expect(tx.delete).toHaveBeenCalled()
      expect(tx.insert).toHaveBeenCalled()
    })

    it('should delete but not insert when planItemIds is empty', () => {
      const tx = createMockTx()
      const eventId = 42

      syncEventPlanReferences(tx as any, eventId, [])

      expect(tx.delete).toHaveBeenCalled()
      expect(tx.insert).not.toHaveBeenCalled()
    })

    it('should insert correct values with eventId, planItemId, and createdAt', () => {
      const tx = createMockTx()
      const eventId = 42
      const planItemIds = [10, 20]

      syncEventPlanReferences(tx as any, eventId, planItemIds)

      const insertCall = (tx.insert as any).mock.calls[0]
      const valuesCall = (tx.insert().values as any).mock.calls[0]
      const values = valuesCall[0]

      expect(values).toHaveLength(2)
      expect(values[0]).toMatchObject({ eventId: 42, planItemId: 10 })
      expect(values[0].createdAt).toBeInstanceOf(Date)
      expect(values[1]).toMatchObject({ eventId: 42, planItemId: 20 })
    })
  })

  describe('deleteEventPlanReferences', () => {
    it('should delete all references for the event', () => {
      const tx = createMockTx()
      const eventId = 42

      deleteEventPlanReferences(tx as any, eventId)

      expect(tx.delete).toHaveBeenCalled()
    })
  })
})
