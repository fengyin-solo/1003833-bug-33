# 陶器整理：尺寸保真、状态单向流转与跨页面拼对清单修复

## Context（问题定位）

代码路径：纯前端 Vue 3 + TS，数据层在 `frontend/src/data/` 与 `frontend/src/api/local-service.ts`，页面在 `frontend/src/views/`。三个根因：

1. **零值被当成缺失值**：尺寸目前是字符串字段，没有任何尺寸语义。后续若用 `!value` / `Number(value)` 的假值判断做「完成整理」校验，`0`（最低合法测量值，如器表厚度 0.0cm）会被判为缺失而拦下。需要用 **nullish 语义**（`null/undefined/''` 才算空，`0` 合法），且原始字符串精度永不重写。
2. **归档后仍出现在待整理列表**：通用 `runAction` 对所有动作一视同仁，只校验「是否已处于目标状态」，没有状态机；陶器没有「归档」动作（modules.ts:138-147），且 `pending` 是手写字段，归档行可能仍为 true。列表也没有排除终态。
3. **跨页面拼对清单尺寸对不上**：目前不存在拼对清单。若在出土遗物页另存一份尺寸副本必然漂移——应从陶器模块（尺寸的唯一权威来源）**派生**只读清单，原字符串直接呈现。

需求还要求：空值/零值/缺失/未测量四态分别表达；非法边界值明确报错、不退回重试；列表空态与异常边界说明原因；归档单向不可回退；历史标本按原精度保留；同一标本并发「完成整理 / 登记拼对」只有一个落库，失败不改任何一方状态。

## 设计要点

### 尺寸四态（保真，用 nullish 区分零值）
新增 `frontend/src/data/pottery-measure.ts`，解析行内「尺寸测量」原始值，返回判别联合，**永不回写、不重新格式化**：
- `{ kind: 'empty' }`：`null/undefined/纯空白`（空值）
- `{ kind: 'unmeasured' }`：规范化后命中 `未测量|未测|暂未测量`
- `{ kind: 'missing' }`：命中 `缺失|不详|无`
- `{ kind: 'measured', raw, value }`：`^-?\d+(\.\d+)?\s*(mm|cm|毫米|厘米)?$`，校验 `Number.isFinite` 且 `>= 0`；**`0` 与 `0.0` 合法**（修复核心，不用真值判断）
- 非法显式报错（不退回重试）：负数 → `尺寸不能为负：「<原文>」超出合法边界（最小为 0）`；其它非空但无法解析 → `尺寸「<原文>」不是可识别的测量值，请填写形如 12.5cm 的数值，或标注“未测量/缺失”`
- 提供 `describeMeasure(row)` → `{ text, tone }`：measured 原样显示原文（历史标本原精度），其余显示「空值（未填写）/未测量/缺失/非法：原因」。

### 状态机：单向推进 + 显式非法报错
陶器状态固定顺序 `待整理 → 整理中 → 已整理 → 已拼对 → 已归档`。
- `modules.ts` 陶器 `actions` 增加「归档」→ `已归档`（终态，terminal）。
- 新增 `frontend/src/api/pottery-service.ts`，集中陶器写逻辑（通用 `local-service.ts` 供其余 17 个模块保持不变）：
  - `POTTERY_TRANSITIONS`：当前状态 → 允许动作映射（待整理→开始整理；整理中→完成整理；已整理→登记拼对；已拼对→归档）。
  - **完成整理**先过尺寸门：四态中只有 `measured` 放行；空值/未测量/缺失分别给明确中文原因；非法值报边界/格式错误。
  - 非法流转明确报错且**不回退、不改状态、不重置数据**：越阶（如 待整理直接登记拼对）、终态再操作（`陶器标本已归档，归档为终态，不能再执行任何动作（单向不可回退）`）、目标相同（`已经是「X」，不用重复操作`）。
  - 写库时 `pending = status !== '已归档'`（归档行不再进待整理列表），`revision + 1`，不触碰 `abnormal`。

### 乐观并发（CAS，失败双方状态都不变）
- `EntryRow` 增加可选 `revision?: number`（缺省按 0 读）。
- 暴露分段 API 便于测试与防双击：
  - `stagePotteryAction(id, action, expectedRevision)`：仅校验行存在、动作已登记、`revision === expectedRevision`；不符返回 `标本刚被其他人改动过（版本冲突），请刷新列表后再操作，本次未改动任何状态`，不写库。
  - `commitPotteryAction(token)`：重新读取最新行，再次比对 revision（二次取号），校验状态机流转 + 尺寸门；通过则整行一次性 `saveRows`（唯一写点）并返回 `{ ok, revision }`，失败**不产生任何写入**。
  - 因此同一标本同时 stage「完成整理」「登记拼对」（同一 expectedRevision）时，先 commit 成功、revision 递增；后 commit 版本冲突失败，双方各自状态都不被部分修改。`applyPotteryAction` 封装 stage+commit 供页面点击使用。

### 列表：归档排除 + 空态/异常原因
`listPottery(filters, { includeArchived })`（默认 false）：
- 默认列表只返回非归档行（修复「归档还在待整理列表」）；提供「显示已归档」勾选项。
- 返回 `{ items, total, archivedHidden, stats, statusCounts }`；stats：标本总数/已整理数（已整理+已拼对+已归档）/待整理数（非归档）。
- 空态区分原因并在页面文案说明：无任何标本（可先登记）；筛选无命中（调整筛选条件）；勾选前全部已归档（勾「显示已归档」查看）。
- 数据结构损坏（localStorage 里该模块不是数组）时由 local-store 守卫抛 `陶器整理数据已损坏（本地存储不是数组）…`，页面 try/catch 在页脚红字说明，不静默吞掉。
- `local-store.ts`：给 `listRows` 增加非数组守卫（抛错而非 `?? []` 静默掩盖）。

### 跨页面出土遗物拼对清单（派生，不复制尺寸）
- `potteryMatchList()`：从陶器行派生状态 ∈ {已拼对, 已归档} 的标本，字段 `标本编号/出土单位/器形类别/尺寸测量(raw)/拼对状态`，尺寸直接用原始字符串，天然与陶器页一致。
- 在出土遗物页（`views/artifact/index.vue`）主表下新增「出土遗物拼对清单」区块：空态说明原因（尚无已拼对陶器标本；或读取异常原因）；尺寸非法行内显示原因。
- 陶器页与导出 CSV 尺寸列同样使用 raw，全程无第二份尺寸。

### 种子数据
重写 `seed.ts` pottery 为 6 行，覆盖各态并保证 pending 与状态一致：
- POTT-0001 待整理、尺寸 `""`（空值，pending）
- POTT-0002 整理中、尺寸 `"0.0cm"`（**合法零值**，abnormal=true 保留）
- POTT-0003 已整理、尺寸 `"12.5cm"`
- POTT-0004 已拼对、尺寸 `"8 cm"`（跨页面清单可见）
- POTT-0005 已归档、尺寸 `"10.2厘米"`（pending=false，默认列表不可见）
- POTT-0006 整理中、尺寸 `"-3cm"`（非法边界：完成整理时报明确错误，原精度保留）
每行带 `revision: 1`。其它模块种子不动。

### 页面改动
- `views/pottery/index.vue`：改用 pottery-service；动作按当前状态渲染（归档行无动作并标注「已归档·终态」）；尺寸列用 `describeMeasure` 着色；「显示已归档」勾选；动态 stats/图例基于全部行；空态与异常按上述原因文案；动作期间禁用按钮（防并发双击）。
- `views/artifact/index.vue`：下方增加派生来的拼对清单区块（含空态/异常原因），其余逻辑不动。
- `global.css` 增补少量 tone/空态/区块样式（沿用现有变量与风格）。

## 关键文件
- 新增 `frontend/src/data/pottery-measure.ts`
- 新增 `frontend/src/api/pottery-service.ts`
- 改 `frontend/src/data/types.ts`（`revision?`）
- 改 `frontend/src/data/modules.ts`（陶器加「归档」动作）
- 改 `frontend/src/data/seed.ts`（pottery 6 行）
- 改 `frontend/src/data/local-store.ts`（非数组守卫）
- 改 `frontend/src/views/pottery/index.vue`
- 改 `frontend/src/views/artifact/index.vue`（拼对清单区块）
- 改 `frontend/src/styles/global.css`
- 新增 `scripts/verify-pottery.mjs`（见下，gitignore 外的普通脚本，仅 dev 依赖 esbuild，仓库已随 vite 安装）

## 复用与不改动
- 通用 `filterRows/listEntries/runAction/exportEntries` 对其它 17 个模块保持现状；陶器导出复用 `exportEntries`（raw 已保真）。
- 不引入新 npm 依赖、不加路由、不改导航。

## 验证
1. `cd frontend && npx vue-tsc --noEmit` 通过；`npm run build` 通过。
2. 新增 `scripts/verify-pottery.mjs`：用 esbuild 把 TS 源 bundle（alias 无需，脚本内用相对路径 import），预置 `globalThis.window.localStorage` 内存 shim，Node 运行断言：
   - 零值：`0`/`0.0cm` 解析为 measured 且 value===0；完成整理放行（回归核心 bug）
   - 空/未测量/缺失分别成态；完成整理分别报各自原因且状态不变
   - `-3cm` 报负数边界错；`abc` 报格式错；均不退回、不改状态
   - 非法流转/终态再操作报明确错；归档后不能回退任何动作
   - 归档行 pending=false 且默认 `listPottery` 不可见，勾选后可见
   - `potteryMatchList` 只含已拼对/已归档，尺寸 raw 与陶器行逐字相等（0004、0005）
   - 并发：对同一行同 revision 先 stage 完成整理与登记拼对两个 token，先 commit 成功 revision 递增，后 commit 返回版本冲突且最终状态只体现先到者；两边失败路径后重查无任何写入
   - 历史精度：`10.2厘米`、`0.0cm` describe/导出原样
   - 运行：`node scripts/verify-pottery.mjs`，全绿退出码 0
3. 手动（dev server）：陶器页零值行可完成整理；空/未测量/缺失/负数各自提示；归档行从默认列表消失且无动作按钮；勾选可查看；出土遗物页拼对清单尺寸与陶器页一致；双击同一动作只有一次生效。
