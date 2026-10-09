import { realpath as fsRealpath } from 'fs/promises'

/** Resolve the real path, returning null on any error (ENOENT, EACCES, etc). */
export async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await fsRealpath(p)
  } catch {
    return null
  }
}
