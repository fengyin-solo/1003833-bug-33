import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, compareAndSaveRow, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  POTTERY_KEY,
  formatSize,
  guardPotterAction,
  isPendingRow,
  parseSize,
} from '@/data/pottery'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, PotteryMatchRow } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, expectedVersion?: number): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 陶器走专用状态机：单向推进、归档不可回退、完成整理校验尺寸保真四态、乐观锁防并发。
  if (key === POTTERY_KEY) {
    return runPotteryAction(meta, id, action, target, expectedVersion)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  // 「已归档」在任何模块都是终态：归档单向，不接受回退或继续流转。
  if (current === '已归档') {
    return { ok: false, message: `${meta.entity}已归档，归档单向不可回退` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runPotteryAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
  expectedVersion?: number,
): ActionResult {
  const rows = listRows(meta.key)
  const seen = rows.find((row) => Number(row.id) === id)
  if (typeof expectedVersion !== 'number') {
    expectedVersion = seen?.version ?? 0
  }
  const { outcome, guard } = compareAndSaveRow(meta.key, id, expectedVersion, (row) => {
    const check = guardPotterAction(row, action, target)
    if (!check.ok) {
      return { guard: check, result: null }
    }
    const parsed = parseSize(row['尺寸测量'])
    return {
      guard: { ok: true },
      result: target,
      patch: {
        status: target,
        pending: target !== '已归档',
        // 尺寸非法保持异常标记；尺寸转成合法测量值后异常解除。
        abnormal: parsed.kind === 'illegal',
      },
    }
  })
  if (!guard.ok) {
    return { ok: false, message: guard.message ?? '操作未通过校验，状态未改变' }
  }
  if (outcome.committed) {
    return { ok: true, message: `陶器标本已${action}，当前状态「${outcome.row.status}」` }
  }
  if (outcome.reason === 'missing') {
    return { ok: false, message: `没有找到编号为 ${id} 的陶器标本` }
  }
  return {
    ok: false,
    message:
      `该标本刚被其他操作更新（当前「${outcome.latest.status}」，版本 ${outcome.latest.version ?? 0}），` +
      '并发动作只允许一方落库，本次未改动任何状态；请按最新状态重新确认后再操作',
  }
}

/**
 * 出土遗物页的「拼对清单」：数据源只有陶器整理这一处，尺寸字段经同一保真
 * 格式化函数输出，保证两个页面看到的口径/精度完全一致。
 */
export function listPotteryMatches(): PotteryMatchRow[] {
  return listRows(POTTERY_KEY)
    .filter((row) => row.status === '已拼对' || row.status === '已归档')
    .map((row) => ({
      id: row.id,
      标本编号: String(row['标本编号'] ?? ''),
      出土单位: String(row['出土单位'] ?? ''),
      器形类别: String(row['器形类别'] ?? ''),
      尺寸测量: formatSize(row['尺寸测量']),
      status: String(row.status),
      version: row.version ?? 0,
    }))
}

/** 陶器待整理列表：已归档标本单向离场，不再出现在任何待办范围。 */
export function listPotteryPending(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(POTTERY_KEY), filters).filter((row) => isPendingRow(row.status))
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
