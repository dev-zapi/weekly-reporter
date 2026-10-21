import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readConfig,
  writeConfig,
  updateMachineField,
  maskPat,
  getFilePermissions,
} from './configure-pat.mjs'

describe('configure-pat', () => {
  let tempDir
  let configPath

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'configure-pat-test-'))
    configPath = join(tempDir, 'auth.json')
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('readConfig', () => {
    it('returns null when file does not exist', () => {
      expect(readConfig(configPath)).toBeNull()
    })

    it('returns null when file is malformed', () => {
      writeFileSync(configPath, 'not json', 'utf8')
      expect(readConfig(configPath)).toBeNull()
    })

    it('reads and parses valid config', () => {
      const config = { password: 'test123', machine: { pat: 'wrp_test' } }
      writeFileSync(configPath, JSON.stringify(config), 'utf8')
      expect(readConfig(configPath)).toEqual(config)
    })
  })

  describe('writeConfig', () => {
    it('creates directory and file with 600 permissions', () => {
      const config = { machine: { pat: 'wrp_test' } }
      writeConfig(config, configPath)

      expect(existsSync(configPath)).toBe(true)
      const stats = statSync(configPath)
      expect((stats.mode & 0o777).toString(8)).toBe('600')
    })

    it('writes valid JSON', () => {
      const config = { password: 'test', machine: { pat: 'wrp_test' } }
      writeConfig(config, configPath)

      const content = readFileSync(configPath, 'utf8')
      expect(JSON.parse(content)).toEqual(config)
    })

    it('fixes permissions on existing file', () => {
      // Create file with wrong permissions
      writeFileSync(configPath, '{}', { mode: 0o644 })
      const config = { machine: { pat: 'wrp_test' } }
      writeConfig(config, configPath)

      const stats = statSync(configPath)
      expect((stats.mode & 0o777).toString(8)).toBe('600')
    })
  })

  describe('updateMachineField', () => {
    it('creates machine field when config is null', () => {
      const result = updateMachineField(null, { pat: 'wrp_test' })
      expect(result).toEqual({ machine: { pat: 'wrp_test' } })
    })

    it('creates machine field when config has no machine', () => {
      const result = updateMachineField({ password: 'test' }, { pat: 'wrp_test' })
      expect(result).toEqual({
        password: 'test',
        machine: { pat: 'wrp_test' },
      })
    })

    it('updates machine field while preserving password', () => {
      const config = {
        password: 'test',
        machine: { baseUrl: 'http://old.com', pat: 'wrp_old' },
      }
      const result = updateMachineField(config, { pat: 'wrp_new' })
      expect(result).toEqual({
        password: 'test',
        machine: { baseUrl: 'http://old.com', pat: 'wrp_new' },
      })
    })

    it('preserves unknown fields', () => {
      const config = {
        password: 'test',
        machine: { pat: 'wrp_test' },
        unknownField: 'value',
      }
      const result = updateMachineField(config, { baseUrl: 'http://new.com' })
      expect(result).toEqual({
        password: 'test',
        machine: { pat: 'wrp_test', baseUrl: 'http://new.com' },
        unknownField: 'value',
      })
    })

    it('removes machine field when all values are undefined', () => {
      const config = {
        password: 'test',
        machine: { baseUrl: 'http://test.com', pat: 'wrp_test' },
      }
      const result = updateMachineField(config, {
        baseUrl: undefined,
        pat: undefined,
      })
      expect(result).toEqual({ password: 'test' })
    })

    it('merges new values with existing machine field', () => {
      const config = { machine: { baseUrl: 'http://old.com' } }
      const result = updateMachineField(config, { pat: 'wrp_new' })
      expect(result).toEqual({
        machine: { baseUrl: 'http://old.com', pat: 'wrp_new' },
      })
    })
  })

  describe('maskPat', () => {
    it('masks short tokens', () => {
      expect(maskPat('short')).toBe('****')
    })

    it('masks null/undefined', () => {
      expect(maskPat(null)).toBe('****')
      expect(maskPat(undefined)).toBe('****')
    })

    it('shows first 6 and last 4 characters', () => {
      expect(maskPat('wrp_1234567890abcdef')).toBe('wrp_12...cdef')
    })

    it('handles exactly 10 character token', () => {
      expect(maskPat('1234567890')).toBe('123456...7890')
    })
  })

  describe('getFilePermissions', () => {
    it('returns null when file does not exist', () => {
      expect(getFilePermissions(configPath)).toBeNull()
    })

    it('returns octal permission string', () => {
      writeFileSync(configPath, '{}', { mode: 0o600 })
      expect(getFilePermissions(configPath)).toBe('600')
    })

    it('detects 644 permissions', () => {
      writeFileSync(configPath, '{}', { mode: 0o644 })
      expect(getFilePermissions(configPath)).toBe('644')
    })
  })

  describe('integration: read-modify-write cycle', () => {
    it('preserves password when updating machine field', () => {
      // Initial config with password
      const initial = { password: 'startup123' }
      writeConfig(initial, configPath)

      // Update machine field
      const current = readConfig(configPath)
      const updated = updateMachineField(current, {
        baseUrl: 'http://test.com',
        pat: 'wrp_test',
      })
      writeConfig(updated, configPath)

      // Verify password is preserved
      const final = readConfig(configPath)
      expect(final).toEqual({
        password: 'startup123',
        machine: {
          baseUrl: 'http://test.com',
          pat: 'wrp_test',
        },
      })
    })

    it('clears machine field while preserving password', () => {
      // Config with both
      const initial = {
        password: 'startup123',
        machine: { baseUrl: 'http://test.com', pat: 'wrp_test' },
      }
      writeConfig(initial, configPath)

      // Clear machine field
      const current = readConfig(configPath)
      const updated = updateMachineField(current, {
        baseUrl: undefined,
        pat: undefined,
      })
      writeConfig(updated, configPath)

      // Verify password preserved, machine removed
      const final = readConfig(configPath)
      expect(final).toEqual({ password: 'startup123' })
    })
  })
})
