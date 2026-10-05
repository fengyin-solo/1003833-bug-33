import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 版本号随种子结构升级：陶器尺寸保真与状态机改造对应 v2。
const STORAGE_KEY = 'field-archaeology-digital:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export type CommitOutcome<T> =
  | { committed: true; row: EntryRow; result: T }
  | { committed: false; reason: 'missing' }
  | { committed: false; reason: 'conflict'; latest: EntryRow }

/**
 * 对单条记录做「比较并提交」（乐观锁 CAS）。
 * updater 拿到的是列表内当前最新快照，返回 { guard, result, patch }：
 *  - guard 不过：不写任何状态，直接把 guard 结果带回去；
 *  - expectedVersion 与最新版本不一致：并发冲突，不改任何一方状态；
 *  - 命中：打补丁、version+1 后整表落库。
 */
export function compareAndSaveRow<T>(
  key: string,
  id: number,
  expectedVersion: number,
  updater: (row: EntryRow) => {
    guard: { ok: boolean; message?: string }
    result: T
    patch?: Partial<EntryRow>
  },
): { outcome: CommitOutcome<T>; guard: { ok: boolean; message?: string } } {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { outcome: { committed: false, reason: 'missing' }, guard: { ok: false } }
  }
  const current = rows[index]
  const update = updater(current)
  if (!update.guard.ok) {
    return { outcome: { committed: false, reason: 'missing' }, guard: update.guard }
  }
  const currentVersion = current.version ?? 0
  if (currentVersion !== expectedVersion) {
    return {
      outcome: { committed: false, reason: 'conflict', latest: current },
      guard: update.guard,
    }
  }
  const updated: EntryRow = {
    ...current,
    ...update.patch,
    version: currentVersion + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return {
    outcome: { committed: true, row: updated, result: update.result },
    guard: update.guard,
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
