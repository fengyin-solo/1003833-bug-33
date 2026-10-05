/* 校验脚本（不进业务包）：陶器尺寸保真、状态机单向、并发 CAS、跨页面拼对清单。 */
import { resetRows, listRows, storageKey } from '../frontend/src/data/local-store'
import {
  runAction,
  listPotteryPending,
  listPotteryMatches,
} from '../frontend/src/api/local-service'
import {
  formatSize,
  parseSize,
  availableActions,
  guardPotterAction,
} from '../frontend/src/data/pottery'
import { MODULE_BY_KEY } from '../frontend/src/data/modules'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures++
    console.error(`FAIL ${name} ${detail}`)
  }
}

// Node 环境没有 window/localStorage，local-store 会直接走种子 fallback。
;(globalThis as { window?: unknown }).window = undefined

resetRows('pottery')
const meta = MODULE_BY_KEY.get('pottery')!

// ---------- 尺寸解析：空值/零值/缺失/未测量 分别表达 ----------
check('数值 12.50 按原精度解析为 measured', parseSize('12.50').kind === 'measured')
check('数值 0 是合法最低测量值', parseSize(0).kind === 'measured')
check('字符串 "0" 是合法测量值', parseSize('0').kind === 'measured')
check('字符串 "0.0cm" 是合法测量值', parseSize('0.0cm').kind === 'measured')
check('空字符串 => empty', parseSize('').kind === 'empty')
check('null => missing', parseSize(null).kind === 'missing')
check('「缺失」=> missing', parseSize('缺失').kind === 'missing')
check('「未测量」=> unmeasured', parseSize('未测量').kind === 'unmeasured')
check('负数 -3.2 => illegal', parseSize('-3.2').kind === 'illegal')
check('非数值 约十三 => illegal', parseSize('约十三').kind === 'illegal')
check('12.50 原精度保真（不被 Number 归一成 12.5）', formatSize('12.50') === '12.50')
check('0 展示为 0 而不是缺失占位', formatSize(0) === '0')
check('空值文案独立', formatSize('') === '（空值·尚未录入尺寸）')
check('缺失文案独立', formatSize('缺失') === '（缺失：缺失）')
check('未测量文案独立', formatSize('未测量') === '（未测量：未测量）')
check('非法值文案带原值', formatSize('约十三').includes('非法测量值：约十三'))

// ---------- 待整理列表：归档标本离场 ----------
const pending = listPotteryPending()
check('待整理列表不含已归档标本', pending.items.every((r) => r.status !== '已归档'))
check('种子里已归档的 POTT-0010 不在待整理列表', !pending.items.some((r) => r.id === 10))
check('已拼对但未归档的 POTT-0009 仍在待整理范围', pending.items.some((r) => r.id === 9))

// ---------- 零值完成整理不被拦 ----------
const r2 = runAction('pottery', 2, '完成整理', 1) // POTT-0002 尺寸 0，整理中
check('零值标本可完成整理', r2.ok, r2.message)
check('完成整理后状态为已整理', listRows('pottery').find((r) => r.id === 2)!.status === '已整理')
check('版本号自增为 2', listRows('pottery').find((r) => r.id === 2)!.version === 2)
check('零值动作后异常标记解除', listRows('pottery').find((r) => r.id === 2)!.abnormal === false)

// ---------- 空值/缺失/未测量/非法：完成整理被明确报错，且状态不改 ----------
const before4 = listRows('pottery').find((r) => r.id === 4)!.status
const e4 = runAction('pottery', 4, '开始整理', 0)
check('空值标本可开始整理', e4.ok, e4.message)
const e4b = runAction('pottery', 4, '完成整理', 1)
check('空值完成整理被拒', !e4b.ok && e4b.message.includes('空值'), e4b.message)
check('空值拒绝后状态停留整理中', listRows('pottery').find((r) => r.id === 4)!.status === '整理中')
void before4

runAction('pottery', 5, '开始整理', 0)
const e5 = runAction('pottery', 5, '完成整理', 1)
check('缺失完成整理被拒并说明原因', !e5.ok && e5.message.includes('缺失'), e5.message)
check('缺失拒绝不改状态', listRows('pottery').find((r) => r.id === 5)!.status === '整理中')

runAction('pottery', 6, '开始整理', 0)
const e6 = runAction('pottery', 6, '完成整理', 1)
check('未测量完成整理被拒并说明原因', !e6.ok && e6.message.includes('尚未测量'), e6.message)

const e7 = runAction('pottery', 7, '完成整理', 2)
check('非法负数明确报错（不退回重试）', !e7.ok && e7.message.includes('不能为负'), e7.message)
check('非法拒绝后状态不变', listRows('pottery').find((r) => r.id === 7)!.status === '整理中')
check('非法拒绝后版本不变', listRows('pottery').find((r) => r.id === 7)!.version === 2)

const e8 = runAction('pottery', 8, '完成整理', 1)
check('非法文字明确报错', !e8.ok && e8.message.includes('不是可识别的测量值'), e8.message)

// ---------- 状态机：不能跳级、不能回退、归档单向 ----------
const skip = runAction('pottery', 1, '登记拼对', 0) // 待整理 -> 已拼对，跳级
check('待整理不能直接登记拼对（跳级被拒）', !skip.ok && skip.message.includes('单向推进'), skip.message)
check('跳级被拒不改状态', listRows('pottery').find((r) => r.id === 1)!.status === '待整理')

check('归档后无可用动作', availableActions('已归档', meta.actionTargets).length === 0)
const back = runAction('pottery', 10, '完成整理', 4)
check('已归档标本拒绝任何动作', !back.ok && back.message.includes('归档单向不可回退'), back.message)
check('归档标本状态仍是已归档', listRows('pottery').find((r) => r.id === 10)!.status === '已归档')
check('归档标本版本不变', listRows('pottery').find((r) => r.id === 10)!.version === 4)

const g = guardPotterAction(listRows('pottery').find((r) => r.id === 10), '归档', '已归档')
check('重复归档提示已经是该状态', !g.ok && g.message.includes('归档单向不可回退'))

// ---------- 正常推进到归档 ----------
const fwd = runAction('pottery', 1, '开始整理', 0)
check('开始整理成功', fwd.ok, fwd.message)
const fwd2 = runAction('pottery', 1, '完成整理', 1) // 尺寸 12.50 合法
check('合法值完成整理成功', fwd2.ok, fwd2.message)
const fwd3 = runAction('pottery', 1, '登记拼对', 2)
check('登记拼对成功', fwd3.ok, fwd3.message)
const fwd4 = runAction('pottery', 1, '归档', 3)
check('拼对后归档成功', fwd4.ok, fwd4.message)
check('归档后离场', !listPotteryPending().items.some((r) => r.id === 1))
check('归档动作后 pending=false', listRows('pottery').find((r) => r.id === 1)!.pending === false)

// 已整理也可直接归档
const arch2 = runAction('pottery', 2, '归档', 2)
check('已整理可直接归档', arch2.ok, arch2.message)

// ---------- 并发：同一标本完成整理 vs 登记拼对，只允许一方落库 ----------
resetRows('pottery')
runAction('pottery', 1, '开始整理', 0) // 版本 -> 1
const winner = runAction('pottery', 1, '完成整理', 1) // 合法尺寸 12.50
check('并发第一提交成功', winner.ok, winner.message)
check('第一提交后版本为 2', listRows('pottery').find((r) => r.id === 1)!.version === 2)
const loser = runAction('pottery', 1, '登记拼对', 1) // 仍旧版本
check('并发第二提交冲突失败', !loser.ok && loser.message.includes('并发动作只允许一方落库'), loser.message)
check('失败方未改状态（仍为已整理，不是已拼对）', listRows('pottery').find((r) => r.id === 1)!.status === '已整理')
check('失败方未推进版本（仍为 2）', listRows('pottery').find((r) => r.id === 1)!.version === 2)

// 失败后按最新版本仍可继续
const retryLatest = runAction('pottery', 1, '登记拼对', 2)
check('按最新版本重新提交可成功', retryLatest.ok, retryLatest.message)

// ---------- 跨页面：出土遗物拼对清单同源同精度 ----------
const matches = listPotteryMatches()
check('拼对清单包含已拼对/已归档', matches.some((m) => m.标本编号 === 'POTT-0001'))
check('拼对清单不含在途标本', !matches.some((m) => m.标本编号 === 'POTT-0004'))
const m1 = matches.find((m) => m.id === 1)!
check('拼对清单尺寸原精度一致', m1.尺寸测量 === '12.50')
const m10 = matches.find((m) => m.id === 10)!
check('拼对清单零值显示为 0（不被当缺失）', m10.尺寸测量 === '0')

console.log(`\nstorage: ${storageKey()}`)
if (failures) {
  console.error(`\n${failures} 项校验失败`)
  process.exit(1)
}
console.log('\n全部校验通过')
