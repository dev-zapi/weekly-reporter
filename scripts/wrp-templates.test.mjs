// Behaviour tests for the wrp templates + styles module (#126).
//
// Same seam as the foundation suite: the real `wrp` entry point as a
// subprocess plus a stub HTTP server. Each test observes the request the CLI
// sends, the lines it prints, and its exit code — never module internals.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorLines, runWrp, startStubServer } from './wrp-cli-harness.mjs'

const stubs = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((server) => server.close()))
})

// --- fixtures -------------------------------------------------------------
// Shapes mirror the Go handlers: official rows carry a string id, an array of
// tags and a non-null description; user rows carry a numeric id, nullable
// description/tags, timestamps and the bare REST path /api/templates/<id>.

function officialTemplates() {
  return [
    {
      id: 'official-general',
      name: '通用正式周报模板',
      description: '适用于大多数场景的正式周报',
      tags: ['正式', '通用'],
      content: '你是通用正式写作助手。\n请按正式格式总结风险与进展。',
      aiStyle: 'formal',
    },
    {
      id: 'official-tech-dev',
      name: '技术研发专属周报模板',
      description: '面向技术研发团队',
      tags: ['技术', '研发'],
      content: '你是技术研发写作助手。\n突出技术细节。',
      aiStyle: 'technical',
    },
  ]
}

function userTemplates() {
  return [
    {
      id: 3,
      name: '我的极简模板',
      content: '你是极简写作助手。\n只写结论，不写背景。',
      description: '个人用的极简模板',
      tags: '个人,极简',
      sourceTemplateId: 'official-minimal',
      aiStyle: 'concise',
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-02T09:30:00.000Z',
    },
  ]
}

function aiStyles() {
  return [
    {
      key: 'formal',
      label: '正式',
      systemPrompt: '你是一位正式的周报写作助手。\n保持客观。',
      temperature: '0.3',
      detailLevel: 'standard',
      resultOriented: null,
      isDefault: true,
    },
    {
      key: 'technical',
      label: '技术研发',
      systemPrompt: '你是技术专家，突出工程细节和风险。',
      temperature: '0.4',
      detailLevel: 'detailed',
      resultOriented: 'true',
      isDefault: false,
    },
    {
      key: 'concise',
      label: '简洁',
      systemPrompt: '极简：只写结论。',
      temperature: '0.2',
      detailLevel: null,
      resultOriented: null,
      isDefault: false,
    },
    {
      key: 'detailed',
      label: '详细',
      systemPrompt: '详细展开每个事项。',
      temperature: '0.5',
      detailLevel: 'detailed',
      resultOriented: null,
      isDefault: false,
    },
  ]
}

/** A stub whose routes can be overridden per test; unknown routes 404 loudly. */
async function stub(overrides = {}) {
  const table = {
    'GET /api/templates': () => ({ status: 200, body: { official: officialTemplates(), user: userTemplates() } }),
    'GET /api/prompts/styles': () => ({ status: 200, body: { styles: aiStyles() } }),
    ...overrides,
  }
  const server = await startStubServer((req) => {
    const handler = table[`${req.method} ${req.url}`]
    if (!handler) {
      return { status: 404, body: { error: `unexpected ${req.method} ${req.url}`, code: 'UNEXPECTED' } }
    }
    return typeof handler === 'function' ? handler(req) : handler
  })
  stubs.push(server)
  return server
}

function jsonBody(request) {
  return JSON.parse(request.body)
}

function outputLines(stdout) {
  return stdout.split('\n').filter(Boolean)
}

// --- list -----------------------------------------------------------------

describe('wrp templates list', () => {
  it('lists both kinds with selection IDs, style, size and opening line', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'list'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('official-general')
    expect(result.stdout).toContain('official-tech-dev')
    expect(result.stdout).toContain('user-3')
    expect(result.stdout).toContain('[official]')
    expect(result.stdout).toContain('[user]')
    expect(result.stdout).toContain('style: formal')
    expect(result.stdout).toContain('chars')
    expect(result.stdout).toContain('通用正式周报模板')
    // Opening line only: a multi-line body belongs to `show` (format law 5).
    expect(result.stdout).toContain('你是通用正式写作助手。')
    expect(result.stdout).not.toContain('请按正式格式总结风险与进展')
    expect(result.stdout).toContain('— 3 template(s)')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('GET')
    expect(server.requests[0].url).toBe('/api/templates')
  })

  it('respects --kind official|user with the matching footer count', async () => {
    const server = await stub()

    const official = await runWrp(['templates', 'list', '--kind', 'official'], { stub: server })
    expect(official.code).toBe(0)
    expect(official.stdout).toContain('official-general')
    expect(official.stdout).not.toContain('user-3')
    expect(official.stdout).toContain('— 2 template(s)')

    const user = await runWrp(['templates', 'list', '--kind', 'user'], { stub: server })
    expect(user.code).toBe(0)
    expect(user.stdout).toContain('user-3')
    expect(user.stdout).not.toContain('official-general')
    expect(user.stdout).toContain('— 1 template(s)')
  })

  it('matches --query against name, content, tags and description', async () => {
    const server = await stub()

    const byContent = await runWrp(['templates', 'list', '--query', '风险'], { stub: server })
    expect(byContent.code).toBe(0)
    expect(byContent.stdout).toContain('official-general')
    expect(byContent.stdout).not.toContain('official-tech-dev')
    expect(byContent.stdout).toContain('— 1 template(s)')

    const byTags = await runWrp(['templates', 'list', '--query', '研发'], { stub: server })
    expect(byTags.stdout).toContain('official-tech-dev')
    expect(byTags.stdout).not.toContain('official-general')

    const byDescription = await runWrp(['templates', 'list', '--query', '个人用'], { stub: server })
    expect(byDescription.stdout).toContain('user-3')
  })

  it('rejects an invalid --kind and prints an explicit empty state', async () => {
    const server = await stub()

    const bad = await runWrp(['templates', 'list', '--kind', 'bogus'], { stub: server })
    expect(bad.code).not.toBe(0)
    expect(errorLines(bad.stderr)).toHaveLength(1)
    expect(bad.stderr).toContain('✗')
    expect(server.requests).toHaveLength(0)

    const empty = await runWrp(['templates', 'list', '--query', '不存在的东西'], { stub: server })
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('No templates matched')
  })
})

// --- show and reference resolution ----------------------------------------

describe('wrp templates show', () => {
  it('defaults to both parts: meta plus the content block', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', 'user-3'], { stub: server, env: { TZ: 'UTC' } })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('user-3')
    expect(result.stdout).toContain('[user]')
    expect(result.stdout).toContain('style: concise')
    expect(result.stdout).toContain('created: 2026-10-01T08:00:00+00:00   updated: 2026-10-02T09:30:00+00:00')
    expect(result.stdout).toContain('description: 个人用的极简模板')
    expect(result.stdout).toContain('tags: 个人,极简')
    expect(result.stdout).toContain('cloned from official-minimal')
    expect(result.stdout).toContain('content:')
    expect(result.stdout).toContain('你是极简写作助手。')
    expect(result.stdout).toContain('只写结论，不写背景。')
  })

  it('renders created/updated in the system zone with an offset', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', 'user-3', '--part', 'meta'], {
      stub: server,
      env: { TZ: 'Asia/Shanghai' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('created: 2026-10-01T16:00:00+08:00   updated: 2026-10-02T17:30:00+08:00')
  })

  it('--part meta is cheap and prints no content', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', 'official-general', '--part', 'meta'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('official-general')
    expect(result.stdout).toContain('read-only')
    expect(result.stdout).not.toContain('content:')
    expect(result.stdout).not.toContain('你是通用正式写作助手。')
  })

  it('--part content prints only the content block', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', 'official-general', '--part', 'content'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('你是通用正式写作助手。')
    expect(result.stdout).not.toContain('style: formal')
  })

  it('rejects an invalid --part without calling the API', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', 'user-3', '--part', 'bogus'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(server.requests).toHaveLength(0)
  })
})

describe('template reference resolution', () => {
  it('accepts a selection ID, a bare user ID, and a case-insensitive name substring', async () => {
    const server = await stub()

    const bySelection = await runWrp(['templates', 'show', 'user-3', '--part', 'meta'], { stub: server })
    expect(bySelection.code).toBe(0)
    expect(bySelection.stdout).toContain('user-3')

    const byBareId = await runWrp(['templates', 'show', '3', '--part', 'meta'], { stub: server })
    expect(byBareId.code).toBe(0)
    expect(byBareId.stdout).toContain('user-3')

    // Substring, case-insensitive against the Latin part of the name.
    const byName = await runWrp(['templates', 'show', '极简', '--part', 'meta'], { stub: server })
    expect(byName.code).toBe(0)
    expect(byName.stdout).toContain('user-3')
  })

  it('fails loudly with the candidate list when a name is ambiguous', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'show', '模板'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain("'模板'")
    expect(result.stderr).toContain('official-general')
    expect(result.stderr).toContain('official-tech-dev')
    expect(result.stderr).toContain('user-3')
    expect(result.stderr).toContain('→')
  })

  it('reports unknown names and unknown bare user IDs distinctly', async () => {
    const server = await stub()

    const missingName = await runWrp(['templates', 'show', 'nope'], { stub: server })
    expect(missingName.code).not.toBe(0)
    expect(errorLines(missingName.stderr)).toHaveLength(1)
    expect(missingName.stderr).toContain('no template matches')

    const missingId = await runWrp(['templates', 'show', '999'], { stub: server })
    expect(missingId.code).not.toBe(0)
    expect(errorLines(missingId.stderr)).toHaveLength(1)
    expect(missingId.stderr).toContain('no user template with ID 999')
  })
})

// --- official read-only ---------------------------------------------------

describe('official templates are read-only', () => {
  it('refuses update with the clone-to-edit hint and sends no write', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'update', 'official-general', '--description', 'x'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('official')
    expect(result.stderr).toContain('wrp templates clone official-general')
    expect(server.requests.map((request) => request.method)).toEqual(['GET'])
  })

  it('refuses delete with the clone-to-edit hint and sends no write', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'delete', 'official-general', '--confirm'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('wrp templates clone official-general')
    expect(server.requests.map((request) => request.method)).toEqual(['GET'])
  })
})

// --- create ---------------------------------------------------------------

describe('wrp templates create', () => {
  it('posts the template and reports the new selection ID', async () => {
    const server = await stub({
      'POST /api/templates': () => ({
        status: 201,
        body: { template: { id: 12, name: '新模板', content: '正文', aiStyle: 'formal' } },
      }),
    })
    const result = await runWrp(['templates', 'create', '--name', '新模板', '--content', '正文'], { stub: server })

    expect(result.code).toBe(0)
    expect(outputLines(result.stdout)[0]).toMatch(/^✓ template created: user-12/)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].method).toBe('POST')
    expect(server.requests[0].url).toBe('/api/templates')
    expect(jsonBody(server.requests[0])).toEqual({ name: '新模板', content: '正文' })
  })

  it('prefers --file for multi-line content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wrp-template-'))
    const file = join(dir, 'body.md')
    const content = '# 周报\n\n第一行\n第二行'
    await writeFile(file, content)

    const server = await stub({
      'POST /api/templates': () => ({
        status: 201,
        body: { template: { id: 12, name: '文件模板', content, aiStyle: 'formal' } },
      }),
    })
    const result = await runWrp(['templates', 'create', '--name', '文件模板', '--file', file], { stub: server })

    expect(result.code).toBe(0)
    expect(jsonBody(server.requests[0]).content).toBe(content)
  })

  it('requires exactly one of --content and --file', async () => {
    const server = await stub({})

    const neither = await runWrp(['templates', 'create', '--name', 'x'], { stub: server })
    expect(neither.code).not.toBe(0)
    expect(errorLines(neither.stderr)).toHaveLength(1)
    expect(neither.stderr).toContain('--content')
    expect(neither.stderr).toContain('--file')

    const both = await runWrp(
      ['templates', 'create', '--name', 'x', '--content', 'a', '--file', '/tmp/nope'],
      { stub: server },
    )
    expect(both.code).not.toBe(0)
    expect(errorLines(both.stderr)).toHaveLength(1)
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces the name and description length caps before calling the API', async () => {
    const server = await stub({})

    const longName = await runWrp(['templates', 'create', '--name', 'x'.repeat(101), '--content', 'a'], { stub: server })
    expect(longName.code).not.toBe(0)
    expect(errorLines(longName.stderr)).toHaveLength(1)
    expect(longName.stderr).toContain('at most 100')

    const longDescription = await runWrp(
      ['templates', 'create', '--name', 'ok', '--content', 'a', '--description', 'd'.repeat(201)],
      { stub: server },
    )
    expect(longDescription.code).not.toBe(0)
    expect(longDescription.stderr).toContain('at most 200')
    expect(server.requests).toHaveLength(0)
  })

  it('validates --style against the live styles list and names the valid keys on a typo', async () => {
    const server = await stub({})

    const typo = await runWrp(['templates', 'create', '--name', 'ok', '--content', 'a', '--style', 'frmal'], { stub: server })
    expect(typo.code).not.toBe(0)
    expect(errorLines(typo.stderr)).toHaveLength(1)
    expect(typo.stderr).toContain('frmal')
    expect(typo.stderr).toContain('formal')
    expect(server.requests.map((request) => request.url)).toEqual(['/api/prompts/styles'])

    const validStub = await stub({
      'POST /api/templates': () => ({
        status: 201,
        body: { template: { id: 14, name: 'ok', content: 'a', aiStyle: 'technical' } },
      }),
    })
    const valid = await runWrp(['templates', 'create', '--name', 'ok', '--content', 'a', '--style', 'technical'], {
      stub: validStub,
    })
    expect(valid.code).toBe(0)
    expect(jsonBody(validStub.requests.at(-1)).aiStyle).toBe('technical')
  })
})

// --- clone ----------------------------------------------------------------

describe('wrp templates clone', () => {
  it('clones by selection ID and posts sourceId with an optional new name', async () => {
    const server = await stub({
      'POST /api/templates/clone': () => ({
        status: 201,
        body: { template: { id: 13, name: '副本', content: '你是通用正式写作助手。', aiStyle: 'formal' } },
      }),
    })
    const result = await runWrp(['templates', 'clone', 'official-general', '--name', '副本'], { stub: server })

    expect(result.code).toBe(0)
    expect(outputLines(result.stdout)[0]).toMatch(/^✓ template cloned: user-13/)
    expect(jsonBody(server.requests.at(-1))).toEqual({ sourceId: 'official-general', name: '副本' })
  })

  it('omits the name when not passed, letting the server keep the source name', async () => {
    const server = await stub({
      'POST /api/templates/clone': () => ({
        status: 201,
        body: { template: { id: 13, name: '通用正式周报模板', content: '正文', aiStyle: 'formal' } },
      }),
    })
    await runWrp(['templates', 'clone', 'official-general'], { stub: server })

    expect(jsonBody(server.requests.at(-1))).toEqual({ sourceId: 'official-general' })
  })

  it('accepts a content override from --file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wrp-clone-'))
    const file = join(dir, 'body.md')
    await writeFile(file, '覆盖后的正文')
    const server = await stub({
      'POST /api/templates/clone': () => ({
        status: 201,
        body: { template: { id: 13, name: '副本', content: '覆盖后的正文', aiStyle: 'formal' } },
      }),
    })

    await runWrp(['templates', 'clone', 'official-general', '--file', file], { stub: server })
    expect(jsonBody(server.requests.at(-1))).toEqual({ sourceId: 'official-general', content: '覆盖后的正文' })
  })
})

// --- update ---------------------------------------------------------------

describe('wrp templates update', () => {
  it('reads the row and resends it with only the named field changed', async () => {
    const server = await stub({
      'PUT /api/templates/3': (request) => ({
        status: 200,
        body: { template: { ...jsonBody(request), id: 3, createdAt: '2026-10-01T08:00:00.000Z' } },
      }),
    })
    const result = await runWrp(['templates', 'update', 'user-3', '--description', '改过的描述'], { stub: server })

    expect(result.code).toBe(0)
    expect(outputLines(result.stdout)[0]).toMatch(/^✓ template updated: user-3/)
    expect(result.stdout).toContain('changed: description')

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0].url).toBe('/api/templates')
    expect(server.requests[1].method).toBe('PUT')
    expect(server.requests[1].url).toBe('/api/templates/3')
    expect(jsonBody(server.requests[1])).toEqual({
      name: '我的极简模板',
      content: '你是极简写作助手。\n只写结论，不写背景。',
      description: '改过的描述',
      tags: '个人,极简',
      aiStyle: 'concise',
    })
  })

  it('fails when nothing is passed, before any write', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'update', 'user-3'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(server.requests.map((request) => request.method)).toEqual(['GET'])
  })

  it('validates a new style against the live list', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'update', 'user-3', '--style', 'nope'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('nope')
    expect(server.requests.map((request) => request.url)).toEqual(['/api/templates', '/api/prompts/styles'])
  })
})

// --- delete ---------------------------------------------------------------

describe('wrp templates delete', () => {
  it('prints a PLAN and refuses without --confirm', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'delete', 'user-3'], { stub: server })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('PLAN:')
    expect(result.stdout).toContain('user-3')
    expect(result.stdout).toContain('我的极简模板')
    expect(result.stdout).toContain('NOT EXECUTED — re-run with --confirm')
    expect(server.requests.map((request) => request.method)).toEqual(['GET'])
  })

  it('deletes on --confirm and reports the deleted identity', async () => {
    const server = await stub({
      'DELETE /api/templates/3': () => ({ status: 200, body: { success: true, message: 'Template deleted' } }),
    })
    const result = await runWrp(['templates', 'delete', 'user-3', '--confirm'], { stub: server })

    expect(result.code).toBe(0)
    expect(outputLines(result.stdout)[0]).toMatch(/^✓ template deleted: user-3/)
    expect(server.requests.at(-1).method).toBe('DELETE')
    expect(server.requests.at(-1).url).toBe('/api/templates/3')
  })
})

// --- styles ---------------------------------------------------------------

describe('wrp styles list', () => {
  it('prints every style key with temperature, default marker and prompt size', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'list'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('formal')
    expect(result.stdout).toContain('正式')
    expect(result.stdout).toContain('temp 0.3')
    expect(result.stdout).toContain('default')
    expect(result.stdout).toContain('technical')
    expect(result.stdout).toContain('— 4 style(s)')
    expect(server.requests[0].url).toBe('/api/prompts/styles')
  })
})

describe('wrp styles show', () => {
  it('prints the full writing prompt for an exact key', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'show', 'technical'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('technical')
    expect(result.stdout).toContain('技术研发')
    expect(result.stdout).toContain('prompt:')
    expect(result.stdout).toContain('你是技术专家，突出工程细节和风险。')
  })

  it('accepts a unique case-insensitive substring of the key or label', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'show', 'TECH'], { stub: server })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('technical')
  })

  it('lists the valid keys for an unknown style and fails', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'show', 'zzz'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('formal')
    expect(result.stderr).toContain('→')
  })

  it('reports an ambiguous substring with the candidates', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'show', 'a'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(result.stderr).toContain('formal')
    expect(result.stderr).toContain('technical')
  })

  it('requires a key', async () => {
    const server = await stub()
    const result = await runWrp(['styles', 'show'], { stub: server })

    expect(result.code).not.toBe(0)
    expect(errorLines(result.stderr)).toHaveLength(1)
    expect(server.requests).toHaveLength(0)
  })
})

// --- format laws ----------------------------------------------------------

describe('format laws', () => {
  it('law 1: every write prints one ✓ line naming the entity and identity', async () => {
    const createStub = await stub({
      'POST /api/templates': () => ({
        status: 201,
        body: { template: { id: 20, name: '甲', content: 'a', aiStyle: 'formal' } },
      }),
    })
    const created = await runWrp(['templates', 'create', '--name', '甲', '--content', 'a'], { stub: createStub })
    const createLines = outputLines(created.stdout).filter((line) => line.startsWith('✓'))
    expect(createLines).toHaveLength(1)
    expect(createLines[0]).toMatch(/^✓ template created: user-20\b/)

    const cloneStub = await stub({
      'POST /api/templates/clone': () => ({
        status: 201,
        body: { template: { id: 21, name: '乙', content: 'a', aiStyle: 'formal' } },
      }),
    })
    const cloned = await runWrp(['templates', 'clone', 'official-general', '--name', '乙'], { stub: cloneStub })
    expect(outputLines(cloned.stdout).filter((line) => line.startsWith('✓'))[0]).toMatch(
      /^✓ template cloned: user-21\b/,
    )

    const updateStub = await stub({
      'PUT /api/templates/3': () => ({
        status: 200,
        body: { template: { id: 3, name: '我的极简模板', content: 'a', aiStyle: 'concise' } },
      }),
    })
    const updated = await runWrp(['templates', 'update', 'user-3', '--tags', 'x'], { stub: updateStub })
    expect(outputLines(updated.stdout).filter((line) => line.startsWith('✓'))[0]).toMatch(
      /^✓ template updated: user-3\b/,
    )

    const deleteStub = await stub({
      'DELETE /api/templates/3': () => ({ status: 200, body: { success: true } }),
    })
    const deleted = await runWrp(['templates', 'delete', 'user-3', '--confirm'], { stub: deleteStub })
    expect(outputLines(deleted.stdout).filter((line) => line.startsWith('✓'))[0]).toMatch(
      /^✓ template deleted: user-3\b/,
    )
  })

  it('law 2: list lines lead with the id token, bracket metadata, then the body', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'list', '--kind', 'user'], { stub: server })

    const rows = outputLines(result.stdout).filter((line) => line.startsWith('user-'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^user-3 (\[[^\]]+\] )+我的极简模板 — 你是极简写作助手。/)

    const styleRows = outputLines((await runWrp(['styles', 'list'], { stub: server })).stdout).filter((line) =>
      line.startsWith('formal'),
    )
    expect(styleRows[0]).toMatch(/^formal (\[[^\]]+\] )+正式$/)
  })

  it('law 3: every failure is exactly one ✗ line on stderr with a → fix hint', async () => {
    const server = await stub()
    const failures = [
      ['templates', 'list', '--kind', 'bogus'],
      ['templates', 'show', 'nope'],
      ['templates', 'show', '999'],
      ['templates', 'show', '模板'],
      ['templates', 'update', 'official-general', '--description', 'x'],
      ['templates', 'update', 'user-3', '--style', 'frmal'],
      ['templates', 'delete', 'official-general', '--confirm'],
      ['styles', 'show', 'zzz'],
      ['styles', 'show', 'a'],
    ]

    for (const args of failures) {
      const result = await runWrp(args, { stub: server })
      expect(result.code, `${args.join(' ')} should exit non-zero`).not.toBe(0)
      expect(errorLines(result.stderr), `${args.join(' ')} prints one ✗ line`).toHaveLength(1)
      expect(result.stderr, `${args.join(' ')} carries a fix hint`).toContain('→')
      expect(result.stdout, `${args.join(' ')} keeps stdout free of ✗`).not.toContain('✗')
    }
  })

  it('law 4: previews open with PLAN: and close with the not-executed footer', async () => {
    const server = await stub()
    const result = await runWrp(['templates', 'delete', 'user-3'], { stub: server })

    expect(result.code).toBe(1)
    expect(result.stdout).toMatch(/^PLAN:\n/)
    expect(result.stdout.trimEnd().endsWith('NOT EXECUTED — re-run with --confirm')).toBe(true)
    expect(result.stderr).toBe('')
  })

  it('law 5: template content and style prompts print only under show', async () => {
    const server = await stub()

    const list = await runWrp(['templates', 'list'], { stub: server })
    expect(list.stdout).not.toContain('只写结论，不写背景。')

    const show = await runWrp(['templates', 'show', 'user-3'], { stub: server })
    expect(show.stdout).toContain('只写结论，不写背景。')

    const styleList = await runWrp(['styles', 'list'], { stub: server })
    expect(styleList.stdout).not.toContain('你是技术专家，突出工程细节和风险。')

    const styleShow = await runWrp(['styles', 'show', 'technical'], { stub: server })
    expect(styleShow.stdout).toContain('你是技术专家，突出工程细节和风险。')
  })
})
