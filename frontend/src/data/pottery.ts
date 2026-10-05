import type { EntryRow } from '@/data/types'

/**
 * 陶器整理域规则。
 *
 * 尺寸测量（口径/腹径/通高一类的测量值）必须保真：原始字符串（含 0、0.0、12.50）
 * 原样保留、原样展示，只在校验时临时解析，不做数值化归一。四种语义分别表达：
 *   - measured  合法测量值（0 是合法最低测量值，不能当缺失）
 *   - empty     空值：字段在，但没有录入任何内容
 *   - missing   缺失：登记时标注「缺失」
 *   - unmeasured 未测量：登记时标注「未测量」
 *   - illegal   非法边界值：负数、非数值等，明确报错，不静默退回
 */

export const POTTERY_KEY = 'pottery'
export const SIZE_FIELD = '尺寸测量'
export const TERMINAL_STATUS = '已归档'

export const POTTERY_STATUSES = ['待整理', '整理中', '已整理', '已拼对', '已归档'] as const

/** 单向推进的状态机：归档是终态，任何动作都不能离开它。 */
const FORWARD_TRANSITIONS: Record<string, string[]> = {
  待整理: ['整理中'],
  整理中: ['已整理'],
  已整理: ['已拼对', '已归档'],
  已拼对: ['已归档'],
  已归档: [],
}

export type SizeKind = 'measured' | 'empty' | 'missing' | 'unmeasured' | 'illegal'

export type ParsedSize =
  | { kind: 'measured'; raw: string; value: number }
  | { kind: 'empty'; raw: '' }
  | { kind: 'missing'; raw: string }
  | { kind: 'unmeasured'; raw: string }
  | { kind: 'illegal'; raw: string; reason: string }

const MISSING_MARKERS = new Set(['缺失', '—', '-', '无'])
const UNMEASURED_MARKERS = new Set(['未测量', '未测', '待测量', '待测'])
// 允许带单位尾缀：0、0.0、12.50、12.5cm、12.5 厘米 都合法；负数、字母非法。
const MEASURED_PATTERN = /^\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米)?$/

/**
 * 解析尺寸测量值。不改动原始字符串，数值只用于边界判定。
 * 0 与 0.0 走 measured 分支——零是合法最低测量值，绝不判成缺失。
 */
export function parseSize(raw: unknown): ParsedSize {
  if (raw === null || raw === undefined) {
    return { kind: 'missing', raw: '' }
  }
  const text = String(raw).trim()
  if (text === '') {
    return { kind: 'empty', raw: '' }
  }
  if (MISSING_MARKERS.has(text)) {
    return { kind: 'missing', raw: text }
  }
  if (UNMEASURED_MARKERS.has(text)) {
    return { kind: 'unmeasured', raw: text }
  }
  if (MEASURED_PATTERN.test(text)) {
    const value = Number(text.match(/^\d+(?:\.\d+)?/)![0])
    return { kind: 'measured', raw: text, value }
  }
  const reason = text.startsWith('-')
    ? `尺寸测量「${text}」非法：测量值不能为负，请按口径/腹径/通高的非负数值（最低 0）录入`
    : `尺寸测量「${text}」非法：不是可识别的测量值，请录入非负数值（允许 0、小数与 cm/毫米 尾缀）`
  return { kind: 'illegal', raw: text, reason }
}

export function sizeKindOfRow(row: EntryRow): SizeKind {
  return parseSize(row[SIZE_FIELD]).kind
}

/**
 * 跨页面共用的尺寸展示：所有读「尺寸测量」的清单（含出土遗物页的拼对清单）
 * 都走这里，保证原精度展示与四种语义的文案完全一致。
 */
export function formatSize(raw: unknown): string {
  const parsed = parseSize(raw)
  switch (parsed.kind) {
    case 'measured':
      // 原精度保真：直接回显 trim 后的原始录入，不做 Number 归一（12.50 不变成 12.5）。
      return parsed.raw
    case 'empty':
      return '（空值·尚未录入尺寸）'
    case 'missing':
      return parsed.raw === '' ? '（缺失·该字段无记录）' : `（缺失：${parsed.raw}）`
    case 'unmeasured':
      return `（未测量：${parsed.raw}）`
    case 'illegal':
      return `（非法测量值：${parsed.raw}）`
  }
}

/** 待整理列表范围：只排除已归档（终态单向，不再回到任何待办列表）。 */
export function isPendingRow(status: unknown): boolean {
  return String(status) !== TERMINAL_STATUS
}

export function canTransition(from: string, to: string): boolean {
  return (FORWARD_TRANSITIONS[from] ?? []).includes(to)
}

/** 当前状态下可执行的动作（按状态机单向推进，归档后为空）。 */
export function availableActions(status: unknown, actionTargets: Record<string, string>): string[] {
  const allowed = new Set(FORWARD_TRANSITIONS[String(status)] ?? [])
  return Object.entries(actionTargets)
    .filter(([, target]) => allowed.has(target))
    .map(([action]) => action)
}

export type GuardResult = { ok: true } | { ok: false; message: string }

/**
 * 动作前置校验（在乐观锁事务内对最新快照执行）：
 * 非法边界值明确报错；未测量/缺失/空值挡住完成整理并说明原因；不回退、不跳级。
 */
export function guardPotterAction(
  row: EntryRow | undefined,
  action: string,
  target: string | undefined,
): GuardResult {
  if (!target) {
    return { ok: false, message: `陶器标本没有登记「${action}」这个动作` }
  }
  if (!row) {
    return { ok: false, message: `没有找到该陶器标本，可能已被移除` }
  }
  const current = String(row.status)
  if (current === TERMINAL_STATUS) {
    return { ok: false, message: `标本已归档，归档单向不可回退，不能再执行「${action}」` }
  }
  if (current === target) {
    return { ok: false, message: `标本已经是「${target}」，不用重复操作` }
  }
  if (!canTransition(current, target)) {
    return {
      ok: false,
      message: `标本当前为「${current}」，状态只能单向推进，不能通过「${action}」跳到「${target}」`,
    }
  }
  if (action === '完成整理') {
    const parsed = parseSize(row[SIZE_FIELD])
    if (parsed.kind === 'illegal') {
      return { ok: false, message: parsed.reason }
    }
    if (parsed.kind === 'unmeasured') {
      return { ok: false, message: `尺寸测量尚未测量（原值「${parsed.raw}」），测量后才能完成整理` }
    }
    if (parsed.kind === 'missing') {
      return { ok: false, message: '尺寸测量缺失，无法完成整理；补测到合法数值（最低 0）后再提交' }
    }
    if (parsed.kind === 'empty') {
      return { ok: false, message: '尺寸测量为空值，尚未录入；补测到合法数值（最低 0）后才能完成整理' }
    }
  }
  return { ok: true }
}
