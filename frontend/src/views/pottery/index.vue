<template>
  <section class="page" data-module="pottery">
    <header class="page-head">
      <div>
        <h2>陶器整理管理</h2>
        <p class="page-desc">维护陶器标本，围绕标本编号、出土单位、器形类别、纹饰特征做登记、筛选与状态流转。尺寸测量保真：0 是合法最低测量值；空值、缺失、未测量分别表达。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记陶器标本</button>
        <button class="btn" type="button" @click="exportRows">导出陶器整理清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="scope-bar">
      <span class="scope-label">列表范围</span>
      <label class="scope-item">
        <input v-model="scope" type="radio" value="pending" />
        待整理（已归档标本单向离场，不在此列）
      </label>
      <label class="scope-item">
        <input v-model="scope" type="radio" value="all" />
        全部（含已归档，仅查看）
      </label>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '尺寸测量'">
              <span :class="['size-cell', `size-${kindOf(row)}`]">{{ formatCell(row, column) }}</span>
            </template>
            <template v-else>{{ formatCell(row, column) }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="abnormal-tag" title="尺寸测量存在非法边界值">异常</span>
          </td>
          <td class="row-actions">
            <template v-if="actionsOf(row).length">
              <button
                v-for="action in actionsOf(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="no-action">已归档·动作终态</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">{{ emptyReason }}</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>{{ scope === 'pending' ? `待整理范围内共 ${total} 条（已归档 ${archivedCount} 条不在列表内）` : `全部范围共 ${total} 条（其中已归档 ${archivedCount} 条）` }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  listPotteryPending,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { availableActions, formatSize, sizeKindOfRow } from '@/data/pottery'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pottery')
const columns = ['标本编号', '出土单位', '器形类别', '纹饰特征', '制作工艺', '器表颜色', '尺寸测量', '整理状态']
const statuses = ['待整理', '整理中', '已整理', '已拼对', '已归档']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const scope = ref<'pending' | 'all'>('pending')
const filterFields = columns.slice(0, 3)
// 本地数据被动作更新后，用 tick 让统计/图例/空态重新计算。
const refreshTick = ref(0)

const allRowsView = computed(() => {
  void refreshTick.value
  return listEntries(meta.key).items
})
const archivedCount = computed(() => allRowsView.value.filter((row) => row.status === '已归档').length)

const stats = computed(() => {
  const all = allRowsView.value
  return [
    { label: '标本总数', value: all.length },
    {
      label: '已整理数',
      value: all.filter((row) => ['已整理', '已拼对', '已归档'].includes(String(row.status))).length,
    },
    {
      label: '待整理数',
      value: all.filter((row) => !['已拼对', '已归档'].includes(String(row.status))).length,
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allRowsView.value.filter((row) => String(row.status) === status).length,
  })),
)

const hasActiveFilter = computed(() =>
  Object.values(filters.value).some((value) => value.trim() !== ''),
)

// 空态必须说明原因：是归档范围导致，还是筛选条件没有命中。
const emptyReason = computed(() => {
  if (allRowsView.value.length === 0) {
    return '暂无陶器标本记录：本模块还没有登记任何标本，可先登记陶器标本'
  }
  if (scope.value === 'pending' && rows.value.length === 0) {
    return hasActiveFilter.value
      ? '待整理范围内没有命中筛选条件的标本：已归档标本不参与待整理列表，请调整检索条件或切换到「全部」范围查看'
      : '待整理列表为空：所有标本均已归档（归档单向不可回退）；如需查看历史标本请切换到「全部」范围'
  }
  return '当前筛选条件没有命中任何标本，请放宽或重置检索条件'
})

function formatCell(row: EntryRow, column: string): string {
  if (column === '尺寸测量') {
    return formatSize(row[column])
  }
  const value = row[column]
  // 0 是合法值，必须展示；只有 null/undefined/空串才显示 —。
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function kindOf(row: EntryRow) {
  return sizeKindOfRow(row)
}

function actionsOf(row: EntryRow): string[] {
  return availableActions(row.status, meta.actionTargets)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '陶器标本登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 携带读取时的版本号：同一标本并发「完成整理 / 登记拼对」时，只有一方能落库。
  const result = applyAction(meta.key, Number(row.id), action, row.version ?? 0)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = scope.value === 'pending' ? listPotteryPending(filters.value) : listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '陶器整理列表读取失败，请稍后重试'
  }
  refreshTick.value++
}

// 切换范围即时生效（待整理/含归档的边界）。
watch(scope, reload)

onMounted(reload)
</script>
