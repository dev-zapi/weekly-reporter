import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertLocalGitRepo, getLocalBranchNames } from './local-git-adapter'

const run = promisify(execFile)
const tempDirs: string[] = []

async function git(cwd: string, args: string[]) {
  await run('git', args, { cwd })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('assertLocalGitRepo', () => {
  it('resolves for a valid git repo', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'weekly-reporter-assert-'))
    tempDirs.push(repo)
    await git(repo, ['init'])

    await expect(assertLocalGitRepo(repo)).resolves.toBeUndefined()
  })

  it('rejects a plain non-repo directory with the expected message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weekly-reporter-assert-'))
    tempDirs.push(dir)

    await expect(assertLocalGitRepo(dir)).rejects.toThrow('路径不是 Git 仓库')
  })
})

describe('getLocalBranchNames', () => {
  it('returns sorted branch names for a repo with multiple heads', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'weekly-reporter-branches-'))
    tempDirs.push(repo)
    await git(repo, ['init'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'user.name', 'Test'])
    await writeFile(join(repo, 'README.md'), 'test\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-m', 'initial'])
    await git(repo, ['branch', 'feature'])

    const branches = await getLocalBranchNames(repo)
    // git init default branch may be 'master' or 'main' depending on config
    expect(branches).toContain('feature')
    expect(branches).toHaveLength(2)
    // Verify sorted
    expect(branches).toEqual([...branches].sort())
  })

  it('returns empty array for a non-repo directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weekly-reporter-branches-'))
    tempDirs.push(dir)

    const branches = await getLocalBranchNames(dir)
    expect(branches).toEqual([])
  })
})
