import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getDataSourceVersion, refreshDataSource } from '../data/mockDatabase';
import { abortAllBatches, abortBatch, isBatchRunning } from './executionRegistry';
import { onStorageRollback, resilientStateStorage } from './resilientStorage';
import type {
  BatchRecord,
  BatchStatus,
  FavoriteQuery,
  LegacyHistoryEntry,
  QueryResult,
  QuerySession,
} from '../types/sql';

const DEFAULT_SQL = `SELECT order_no, customer_name, region, amount, status
FROM orders
WHERE amount > 5000 AND status = '已完成'
ORDER BY amount DESC
LIMIT 500;`;

/** 历史账本上限：超出后只回收已关闭标签、未被引用的最旧终态批次 */
const LEDGER_LIMIT = 200;
/** 回填旧数据时使用的占位版本 */
export const LEGACY_VERSION = 'legacy-unpinned';

function createSession(title = '查询 1', sql = DEFAULT_SQL): QuerySession {
  return {
    id: crypto.randomUUID(),
    title,
    sql,
    updatedAt: Date.now(),
    needsRecompute: false,
  };
}

const initialSession = createSession();

type BatchOutcome =
  | { kind: 'success'; result: QueryResult }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'canceled' }
  | { kind: 'superseded'; message?: string };

interface WorkbenchState {
  tabs: QuerySession[];
  activeTabId: string;
  /** 批次账本：标签、结果快照与历史都通过批次号串联 */
  batches: BatchRecord[];
  /** 当前数据源版本；每次提交时把当时的版本固定进批次 */
  dataVersion: string;
  favorites: FavoriteQuery[];

  addTab: (sql?: string) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTab: (id: string, sql: string, title?: string) => void;

  submitBatch: (tabId: string, sql?: string) => string | null;
  retryBatch: (batchId: string) => string | null;
  cancelBatch: (batchId: string) => void;
  completeBatch: (batchId: string, outcome: BatchOutcome) => void;
  refreshDataVersion: () => string;

  clearHistory: () => void;
  addFavorite: (name: string, sql: string) => void;
  removeFavorite: (id: string) => void;
}

function nowIsh(): number {
  return Date.now();
}

/* ---------- 旧数据迁移：缺少批次号 / 版本的记录先回填 ---------- */

interface LegacyPersistedState {
  tabs?: QuerySession[];
  activeTabId?: string;
  history?: LegacyHistoryEntry[];
  favorites?: FavoriteQuery[];
}

function persistShape(persisted: unknown, current: WorkbenchState): WorkbenchPersistShape {
  if (!persisted || typeof persisted !== 'object') {
    return {
      tabs: current.tabs,
      activeTabId: current.activeTabId,
      batches: [],
      dataVersion: current.dataVersion,
      favorites: current.favorites,
    };
  }
  const legacy = persisted as LegacyPersistedState & Partial<WorkbenchPersistShape>;

  // 已经是批次结构：仅做字段补齐
  if (Array.isArray(legacy.batches)) {
    return {
      tabs: (legacy.tabs ?? []).map(normalizeTab),
      activeTabId: legacy.activeTabId ?? legacy.tabs?.[0]?.id ?? current.activeTabId,
      batches: dedupeBatches(legacy.batches).map(normalizeBatch),
      dataVersion: typeof legacy.dataVersion === 'string' ? legacy.dataVersion : LEGACY_VERSION,
      favorites: Array.isArray(legacy.favorites) ? legacy.favorites : current.favorites,
    };
  }

  const tabs = (legacy.tabs ?? []).map(normalizeTab);
  const activeTabId = legacy.activeTabId ?? tabs[0]?.id ?? initialSession.id;
  const seen = new Set<string>();
  const batches: BatchRecord[] = (legacy.history ?? [])
    .filter((entry) => {
      if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => ({
      id: entry.id,
      tabId: activeTabId,
      sql: entry.sql,
      dataVersion: LEGACY_VERSION,
      status: (entry.success ? 'succeeded' : 'failed') as BatchStatus,
      submittedAt: entry.executedAt,
      finishedAt: entry.executedAt,
      elapsedMs: entry.elapsedMs,
      errorMessage: entry.error,
      errorCode: entry.success ? undefined : 'QUERY_001',
      // 旧记录没有结果快照，只有行数等元数据，标记为回填且不保留行数据
      resultRetained: false,
      backfilled: true,
    }));

  // 最近一次成功回填批次作为当前标签的快照参与恢复
  const lastSuccess = batches.find((batch) => batch.status === 'succeeded');
  const lastTerminal = batches[0];
  if (tabs.length && lastTerminal) {
    tabs[0].lastBatchId = lastTerminal.id;
    tabs[0].snapshotBatchId = lastSuccess?.id;
    tabs[0].needsRecompute = true;
  }

  return {
    tabs: tabs.length ? tabs : [createSession()],
    activeTabId,
    batches,
    dataVersion: LEGACY_VERSION,
    favorites: Array.isArray(legacy.favorites) ? legacy.favorites : [],
  };
}

function normalizeTab(tab: QuerySession): QuerySession {
  return {
    id: tab.id,
    title: tab.title ?? '查询',
    sql: tab.sql ?? '',
    updatedAt: tab.updatedAt ?? Date.now(),
    runningBatchId: tab.runningBatchId,
    lastBatchId: tab.lastBatchId,
    snapshotBatchId: tab.snapshotBatchId,
    needsRecompute: tab.needsRecompute ?? false,
  };
}

function normalizeBatch(batch: BatchRecord): BatchRecord {
  return {
    ...batch,
    resultRetained: batch.resultRetained ?? false,
    dataVersion: batch.dataVersion || LEGACY_VERSION,
  };
}

function dedupeBatches(batches: BatchRecord[]): BatchRecord[] {
  const seen = new Set<string>();
  return batches.filter((batch) => {
    if (!batch || typeof batch.id !== 'string' || seen.has(batch.id)) return false;
    seen.add(batch.id);
    return true;
  });
}

interface WorkbenchPersistShape {
  tabs: QuerySession[];
  activeTabId: string;
  batches: BatchRecord[];
  dataVersion: string;
  favorites: FavoriteQuery[];
}

/** 回滚 / 启动恢复时：在飞批次若运行时已不存在，按已取消收敛并决定是否重算 */
let rollbackInProgress = false;

function reconcileState(state: WorkbenchPersistShape): WorkbenchPersistShape {
  const currentVersion = getDataSourceVersion().id;
  const batches = state.batches.map((batch) => {
    if (batch.status !== 'running' || isBatchRunning(batch.id)) return batch;
    return {
      ...batch,
      status: 'canceled' as BatchStatus,
      finishedAt: batch.finishedAt ?? Date.now(),
      errorMessage: rollbackInProgress
        ? '持久化写入失败，已恢复到上一次完整批次'
        : '页面重新加载后，未完成的批次已取消',
    };
  });

  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const tabs = state.tabs.map((tab) => {
    const next: QuerySession = { ...tab, needsRecompute: tab.needsRecompute ?? false };
    if (next.runningBatchId) {
      const batch = batchById.get(next.runningBatchId);
      if (!batch || batch.status !== 'running') {
        // 回滚或重启打断的在飞批次：未固定结果一律重算
        next.needsRecompute = true;
        next.runningBatchId = undefined;
      }
    }
    if (next.lastBatchId && !batchById.has(next.lastBatchId)) next.lastBatchId = undefined;
    if (next.snapshotBatchId && !batchById.has(next.snapshotBatchId)) {
      next.snapshotBatchId = undefined;
    }
    // 快照依据版本落后于当前数据源：结果保留但标记过期
    const snapshot = next.snapshotBatchId ? batchById.get(next.snapshotBatchId) : undefined;
    if (snapshot && snapshot.dataVersion !== currentVersion) {
      next.needsRecompute = true;
    }
    return next;
  });

  return { ...state, tabs, batches, dataVersion: currentVersion };
}

/* ------------------------- Store ------------------------- */

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => ({
      tabs: [initialSession],
      activeTabId: initialSession.id,
      batches: [],
      dataVersion: getDataSourceVersion().id,
      favorites: [
        {
          id: 'favorite-example',
          name: '高金额已完成订单',
          sql: DEFAULT_SQL,
          createdAt: Date.now(),
        },
      ],

      addTab: (sql) => {
        const tab = createSession(`查询 ${get().tabs.length + 1}`, sql);
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      },

      closeTab: (id) => {
        const tab = get().tabs.find((item) => item.id === id);
        const runningId = tab?.runningBatchId;
        if (runningId) abortBatch(runningId, 'tab-closed');
        set((state) => {
          let tabs = state.tabs.filter((item) => item.id !== id);
          let activeTabId = state.activeTabId;
          if (tabs.length === 0) {
            tabs = [createSession()];
            activeTabId = tabs[0].id;
          } else if (state.activeTabId === id) {
            const index = state.tabs.findIndex((item) => item.id === id);
            activeTabId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0].id;
          }
          const closedAt = Date.now();
          // 已关闭标签的在飞批次显式终结，不在账本残留 running
          const batches = state.batches.map((batch) =>
            batch.id === runningId && batch.status === 'running'
              ? {
                  ...batch,
                  status: 'superseded' as BatchStatus,
                  finishedAt: closedAt,
                  errorCode: 'BATCH_SUPERSEDED',
                  errorMessage: '标签已关闭，在飞批次终止',
                }
              : batch,
          );
          return { tabs, activeTabId, batches: pruneLedger(batches, tabs) };
        });
      },

      activateTab: (id) => set({ activeTabId: id }),

      updateTab: (id, sql, title) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === id
              ? { ...tab, sql, title: title ?? tab.title, updatedAt: Date.now() }
              : tab,
          ),
        })),

      /**
       * 提交新批次：固定查询语句与当前数据源版本。
       * 同标签上一个在飞批次立即标记为 superseded 并中止——
       * 它稍后返回（无论成功失败）都会被 completeBatch 的守卫拒绝。
       */
      submitBatch: (tabId, sqlOverride) => {
        const tab = get().tabs.find((item) => item.id === tabId);
        if (!tab) return null;
        const sql = (sqlOverride ?? tab.sql).trim();
        if (!sql) return null;
        const version = getDataSourceVersion().id;
        const batchId = crypto.randomUUID();
        const timestamp = nowIsh();

        set((state) => {
          let batches = state.batches;
          if (tab.runningBatchId) {
            const previousId = tab.runningBatchId;
            abortBatch(previousId, 'superseded');
            batches = batches.map((batch) =>
              batch.id === previousId && batch.status === 'running'
                ? {
                    ...batch,
                    status: 'superseded',
                    finishedAt: timestamp,
                    errorMessage: '同一标签已提交更新批次，旧批次自动失效',
                  }
                : batch,
            );
          }
          const record: BatchRecord = {
            id: batchId,
            tabId,
            sql,
            dataVersion: version,
            status: 'running',
            submittedAt: timestamp,
            resultRetained: false,
          };
          return {
            batches: pruneLedger([record, ...batches], state.tabs),
            tabs: state.tabs.map((item) =>
              item.id === tabId
                ? {
                    ...item,
                    runningBatchId: batchId,
                    lastBatchId: batchId,
                    needsRecompute: false,
                    sql: sqlOverride ?? item.sql,
                    updatedAt: timestamp,
                  }
                : item,
            ),
          };
        });
        return batchId;
      },

      /** 重试终态批次：沿用原批次号做 upsert，不追加重复记录 */
      retryBatch: (batchId) => {
        const batch = get().batches.find((item) => item.id === batchId);
        if (!batch || batch.status === 'running') return null;
        let tab = get().tabs.find((item) => item.id === batch.tabId);
        // 原标签已关闭：新建标签承载该 SQL，但作为新批次提交（保持追溯链清晰）
        if (!tab) {
          const newTab = createSession(`查询 ${get().tabs.length + 1}`, batch.sql);
          const version = getDataSourceVersion().id;
          const timestamp = nowIsh();
          const newId = crypto.randomUUID();
          const record: BatchRecord = {
            id: newId,
            tabId: newTab.id,
            sql: batch.sql,
            dataVersion: version,
            status: 'running',
            submittedAt: timestamp,
            resultRetained: false,
            supersededFrom: batch.id,
          };
          set((state) => ({
            tabs: [...state.tabs, newTab],
            activeTabId: newTab.id,
            batches: pruneLedger([record, ...state.batches], [...state.tabs, newTab]),
          }));
          return newId;
        }
        const version = getDataSourceVersion().id;
        const timestamp = nowIsh();

        set((state) => ({
          batches: state.batches.map((item) =>
            item.id === batchId
              ? {
                  ...item,
                  // 版本已变化时，重试固定为新版本；批次号保持不变
                  dataVersion: version,
                  status: 'running',
                  submittedAt: timestamp,
                  finishedAt: undefined,
                  elapsedMs: undefined,
                  result: undefined,
                  resultRetained: false,
                  errorCode: undefined,
                  errorMessage: undefined,
                  backfilled: item.backfilled,
                }
              : item,
          ),
          tabs: state.tabs.map((item) =>
            item.id === batch.tabId
              ? {
                  ...item,
                  runningBatchId: batchId,
                  lastBatchId: batchId,
                  sql: batch.sql,
                  needsRecompute: false,
                  updatedAt: timestamp,
                }
              : item,
          ),
        }));
        return batchId;
      },

      cancelBatch: (batchId) => {
        abortBatch(batchId);
      },

      /**
       * 批次终态写回。三层守卫保证只有「标签当前在飞批次」能改结果：
       * 1. 批次不存在（已被回滚 / 裁剪）→ 忽略；
       * 2. 批次已终态（取消、被取代、重复晚到）→ 忽略；
       * 3. 已不是该标签的 runningBatchId（更新批次已提交）→ 忽略。
       */
      completeBatch: (batchId, outcome) => {
        const state = get();
        const batch = state.batches.find((item) => item.id === batchId);
        if (!batch || batch.status !== 'running') return;
        const tab = state.tabs.find((item) => item.id === batch.tabId);
        if (!tab || tab.runningBatchId !== batchId) return;

        const timestamp = nowIsh();
        let status: BatchStatus;
        let patch: Partial<BatchRecord> = { finishedAt: timestamp };
        if (outcome.kind === 'success') {
          status = 'succeeded';
          patch = {
            ...patch,
            result: outcome.result,
            elapsedMs: outcome.result.elapsedMs,
            resultRetained: true,
          };
        } else if (outcome.kind === 'canceled') {
          status = 'canceled';
          patch = { ...patch, errorMessage: '用户取消了该批次' };
        } else if (outcome.kind === 'superseded') {
          status = 'superseded';
          patch = {
            ...patch,
            errorCode: 'BATCH_SUPERSEDED',
            errorMessage: outcome.message ?? '数据源版本刷新，旧批次失效',
          };
        } else {
          status = 'failed';
          patch = { ...patch, errorCode: outcome.code, errorMessage: outcome.message };
        }

        set((current) => ({
          batches: current.batches.map((item) =>
            item.id === batchId ? { ...item, ...patch, status } : item,
          ),
          tabs: current.tabs.map((item) => {
            if (item.id !== batch.tabId) return item;
            const next: QuerySession = {
              ...item,
              runningBatchId: undefined,
              lastBatchId: batchId,
            };
            // 只有成功写回才移动结果快照；取消 / 失败 / 旧批次都不能改结果
            if (status === 'succeeded') next.snapshotBatchId = batchId;
            if (status === 'superseded') next.needsRecompute = true;
            return next;
          }),
        }));
      },

      /**
       * 数据源版本刷新：
       * - 先推进内存数据并固定新版本号（在飞批次的版本比较必须立即看到新值）；
       * - 在飞批次立刻中止并标 superseded（晚到的结果由守卫拒绝）；
       * - 已完成快照保留原结果与依据版本，标记过期、按新版本重算。
       */
      refreshDataVersion: () => {
        const nextVersion = refreshDataSource();
        const timestamp = nowIsh();
        // 先中止所有在飞批次的信号（同步），其执行 promise 在下个轮询 tick 被拒绝
        abortAllBatches('superseded');
        set((state) => ({
          dataVersion: nextVersion.id,
          batches: state.batches.map((batch) => {
            if (batch.status !== 'running') return batch;
            return {
              ...batch,
              status: 'superseded',
              finishedAt: timestamp,
              errorCode: 'BATCH_SUPERSEDED',
              errorMessage: `数据源已刷新到 ${nextVersion.id}，依据 ${batch.dataVersion} 的批次失效`,
            };
          }),
          tabs: state.tabs.map((tab) => ({
            ...tab,
            runningBatchId: undefined,
            needsRecompute: tab.sql.trim().length > 0,
          })),
        }));
        return nextVersion.id;
      },

      clearHistory: () => {
        set((state) => {
          // 在飞批次保留（属于当前活动），只清终态历史
          const liveIds = new Set(
            state.batches.filter((batch) => batch.status === 'running').map((batch) => batch.id),
          );
          const batches = state.batches.filter((batch) => liveIds.has(batch.id));
          return {
            batches,
            tabs: state.tabs.map((tab) => ({
              ...tab,
              lastBatchId: liveIds.has(tab.lastBatchId ?? '') ? tab.lastBatchId : undefined,
              snapshotBatchId: undefined,
            })),
          };
        });
      },

      addFavorite: (name, sql) =>
        set((state) => ({
          favorites: [
            { id: crypto.randomUUID(), name: name.trim(), sql, createdAt: Date.now() },
            ...state.favorites.filter((favorite) => favorite.name !== name.trim()),
          ],
        })),

      removeFavorite: (id) =>
        set((state) => ({ favorites: state.favorites.filter((favorite) => favorite.id !== id) })),
    }),
    {
      name: 'pair-wise-yy-06-workbench',
      version: 2,
      storage: resilientStateStorage,
      // zustand 要求版本升级必须提供 migrate；结构转换统一在 merge 中做，
      // 这里仅把旧结构原样透传（v1 为 {tabs,history,...}，merge 负责回填）
      migrate: (persisted) => persisted as never,
      // v1 / 无版本结构与 v2 批次结构都在 merge 中统一回填
      merge: (persisted, current) => {
        const migrated = persistShape(persisted, current as WorkbenchState);
        // 数据源当前版本始终以内存模块为准；旧批次结果继续保留各自依据版本
        migrated.dataVersion = getDataSourceVersion().id;
        const reconciled = reconcileState(migrated);
        return { ...current, ...reconciled };
      },
      partialize: (state) => {
        const referenced = new Set<string>();
        state.tabs.forEach((tab) => {
          if (tab.runningBatchId) referenced.add(tab.runningBatchId);
          if (tab.lastBatchId) referenced.add(tab.lastBatchId);
          if (tab.snapshotBatchId) referenced.add(tab.snapshotBatchId);
        });
        return {
          tabs: state.tabs,
          activeTabId: state.activeTabId,
          dataVersion: state.dataVersion,
          favorites: state.favorites,
          // 未被打开标签引用的历史批次只留元数据，结果行不进持久层
          batches: state.batches.map((batch) =>
            referenced.has(batch.id) || !batch.result
              ? batch
              : {
                  ...batch,
                  resultRetained: false,
                  result: batch.result ? { ...batch.result, rows: [] } : undefined,
                },
          ),
        };
      },
    },
  ),
);

function pruneLedger(batches: BatchRecord[], tabs: QuerySession[]): BatchRecord[] {
  const referenced = new Set<string>();
  tabs.forEach((tab) => {
    if (tab.runningBatchId) referenced.add(tab.runningBatchId);
    if (tab.lastBatchId) referenced.add(tab.lastBatchId);
    if (tab.snapshotBatchId) referenced.add(tab.snapshotBatchId);
  });
  // 账本按 submittedAt 倒序（写入处维持该顺序），回收最旧的未引用终态批次
  const next = batches.filter(
    (batch) => batch.status === 'running' || referenced.has(batch.id),
  );
  const unreferenced = batches.filter(
    (batch) => batch.status !== 'running' && !referenced.has(batch.id),
  );
  return [...next, ...unreferenced.slice(0, LEDGER_LIMIT - next.length)];
}

/* ---------- 写入失败：回滚持久层并恢复内存到上一次完整批次 ---------- */

onStorageRollback((hadLastGood) => {
  if (!hadLastGood) return;
  rollbackInProgress = true;
  // 等在飞批次的 finally（注销 controller）结束后再 rehydrate
  window.setTimeout(() => {
    Promise.resolve(useWorkbenchStore.persist.rehydrate())
      .catch(() => undefined)
      .finally(() => {
        rollbackInProgress = false;
      });
  }, 0);
});
