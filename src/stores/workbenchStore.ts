import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DATA_VERSION, DATA_VERSION_LABEL } from '../data/mockDatabase';
import type {
  FavoriteQuery,
  QueryBatch,
  QueryErrorDetail,
  QueryHistoryEntry,
  QueryResult,
  QuerySession,
} from '../types/sql';

const DEFAULT_SQL = `SELECT order_no, customer_name, region, amount, status
FROM orders
WHERE amount > 5000 AND status = '已完成'
ORDER BY amount DESC
LIMIT 500;`;

function createSession(title = '查询 1', sql = DEFAULT_SQL): QuerySession {
  return {
    id: crypto.randomUUID(),
    title,
    sql,
    updatedAt: Date.now(),
  };
}

const initialSession = createSession();

const STORAGE_KEY = 'pair-wise-yy-06-workbench';
const BACKUP_KEY = 'pair-wise-yy-06-workbench-backup';

/**
 * 安全存储：写入失败时恢复上一次完整批次的快照，
 * 避免部分写入导致状态损坏。
 */
const safeStateStorage = {
  getItem: (name: string): string | null => {
    try {
      const value = localStorage.getItem(name);
      if (value) return value;
      return localStorage.getItem(BACKUP_KEY);
    } catch {
      return localStorage.getItem(BACKUP_KEY);
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      localStorage.setItem(name, value);
      // 写入成功后更新备份
      localStorage.setItem(BACKUP_KEY, value);
    } catch (error) {
      // 写入失败：恢复上一次完整批次
      try {
        const backup = localStorage.getItem(BACKUP_KEY);
        if (backup) {
          localStorage.setItem(name, backup);
        }
      } catch {
        // 恢复也失败时忽略
      }
      throw error;
    }
  },
  removeItem: (name: string): void => {
    localStorage.removeItem(name);
    localStorage.removeItem(BACKUP_KEY);
  },
};

const safeStorage = createJSONStorage<Partial<WorkbenchState>>(() => safeStateStorage);

interface WorkbenchState {
  tabs: QuerySession[];
  activeTabId: string;
  history: QueryHistoryEntry[];
  favorites: FavoriteQuery[];
  dataVersion: number;
  dataVersionLabel: string;
  batches: Record<string, QueryBatch>;
  latestBatchByTab: Record<string, string>;
  addTab: (sql?: string) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTab: (id: string, sql: string, title?: string) => void;
  addHistory: (entry: Omit<QueryHistoryEntry, 'id'>) => void;
  clearHistory: () => void;
  addFavorite: (name: string, sql: string) => void;
  removeFavorite: (id: string) => void;
  submitBatch: (tabId: string, sql: string) => QueryBatch;
  completeBatch: (batchId: string, result: QueryResult) => void;
  failBatch: (batchId: string, error: QueryErrorDetail) => void;
  cancelBatch: (batchId: string) => void;
  getLatestBatch: (tabId: string) => QueryBatch | undefined;
  getDisplayedBatch: (tabId: string) => QueryBatch | undefined;
  bumpDataVersion: () => void;
  recomputeBatch: (batchId: string) => QueryBatch | undefined;
}

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set, get) => ({
      tabs: [initialSession],
      activeTabId: initialSession.id,
      history: [],
      favorites: [
        {
          id: 'favorite-example',
          name: '高金额已完成订单',
          sql: DEFAULT_SQL,
          createdAt: Date.now(),
        },
      ],
      dataVersion: DATA_VERSION,
      dataVersionLabel: DATA_VERSION_LABEL,
      batches: {},
      latestBatchByTab: {},

      addTab: (sql) => {
        const tab = createSession(`查询 ${get().tabs.length + 1}`, sql);
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
      },

      closeTab: (id) => {
        set((state) => {
          if (state.tabs.length === 1) {
            const replacement = createSession();
            return { tabs: [replacement], activeTabId: replacement.id };
          }
          const index = state.tabs.findIndex((tab) => tab.id === id);
          const tabs = state.tabs.filter((tab) => tab.id !== id);
          const activeTabId =
            state.activeTabId === id
              ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0].id)
              : state.activeTabId;
          // 清理该标签的批次引用
          const latestBatchByTab = { ...state.latestBatchByTab };
          delete latestBatchByTab[id];
          return { tabs, activeTabId, latestBatchByTab };
        });
      },

      activateTab: (id) => set({ activeTabId: id }),

      updateTab: (id, sql, title) =>
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  sql,
                  title: title ?? tab.title,
                  updatedAt: Date.now(),
                }
              : tab,
          ),
        })),

      addHistory: (entry) =>
        set((state) => ({
          history: [{ ...entry, id: crypto.randomUUID() }, ...state.history].slice(0, 100),
        })),

      clearHistory: () => set({ history: [] }),

      addFavorite: (name, sql) =>
        set((state) => ({
          favorites: [
            {
              id: crypto.randomUUID(),
              name: name.trim(),
              sql,
              createdAt: Date.now(),
            },
            ...state.favorites.filter((favorite) => favorite.name !== name.trim()),
          ],
        })),

      removeFavorite: (id) =>
        set((state) => ({ favorites: state.favorites.filter((favorite) => favorite.id !== id) })),

      /**
       * 提交批次：固定查询语句与数据源版本，
       * 同一标签只接受最新批次（通过 latestBatchByTab 控制）。
       */
      submitBatch: (tabId, sql) => {
        const state = get();
        const batch: QueryBatch = {
          id: crypto.randomUUID(),
          tabId,
          sql,
          dataVersion: state.dataVersion,
          status: 'running',
          startedAt: Date.now(),
        };
        set((s) => ({
          batches: { ...s.batches, [batch.id]: batch },
          latestBatchByTab: { ...s.latestBatchByTab, [tabId]: batch.id },
          tabs: s.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, latestBatchId: batch.id } : tab,
          ),
        }));
        return batch;
      },

      /**
       * 批次成功：仅当该批次仍是标签下最新批次时才写入结果。
       * 晚到的旧批次标记为 cancelled，不写结果。
       * 历史按 batchId upsert，重试不追加重复记录。
       */
      completeBatch: (batchId, result) => {
        const state = get();
        const batch = state.batches[batchId];
        if (!batch || batch.status !== 'running') return;
        const isLatest = state.latestBatchByTab[batch.tabId] === batchId;
        if (!isLatest) {
          // 晚到的旧批次：标记取消，不写结果
          set((s) => ({
            batches: {
              ...s.batches,
              [batchId]: { ...batch, status: 'cancelled', completedAt: Date.now() },
            },
          }));
          return;
        }
        // 最新批次：写入结果
        const historyId = batch.historyId ?? crypto.randomUUID();
        const historyEntry: QueryHistoryEntry = {
          id: historyId,
          batchId: batch.id,
          tabId: batch.tabId,
          sql: batch.sql,
          dataVersion: batch.dataVersion,
          executedAt: batch.startedAt,
          elapsedMs: result.elapsedMs,
          rowCount: result.rowCount,
          success: true,
        };
        set((s) => {
          const existingIndex = s.history.findIndex((h) => h.batchId === batchId);
          let history: QueryHistoryEntry[];
          if (existingIndex >= 0) {
            history = [...s.history];
            history[existingIndex] = historyEntry;
          } else {
            history = [historyEntry, ...s.history].slice(0, 100);
          }
          return {
            history,
            batches: {
              ...s.batches,
              [batchId]: {
                ...batch,
                status: 'success',
                result,
                completedAt: Date.now(),
                historyId,
              },
            },
            tabs: s.tabs.map((tab) =>
              tab.id === batch.tabId
                ? { ...tab, lastCompleteBatchId: batchId, latestBatchId: batchId }
                : tab,
            ),
          };
        });
      },

      /**
       * 批次失败：仅当该批次仍是标签下最新批次时才记录错误。
       * 失败后展示回退到上一次完整批次的结果。
       */
      failBatch: (batchId, error) => {
        const state = get();
        const batch = state.batches[batchId];
        if (!batch || batch.status !== 'running') return;
        const isLatest = state.latestBatchByTab[batch.tabId] === batchId;
        const historyId = batch.historyId ?? crypto.randomUUID();
        const historyEntry: QueryHistoryEntry = {
          id: historyId,
          batchId: batch.id,
          tabId: batch.tabId,
          sql: batch.sql,
          dataVersion: batch.dataVersion,
          executedAt: batch.startedAt,
          elapsedMs: 0,
          rowCount: 0,
          success: false,
          error: error.message,
        };
        set((s) => {
          const existingIndex = s.history.findIndex((h) => h.batchId === batchId);
          let history: QueryHistoryEntry[];
          if (existingIndex >= 0) {
            history = [...s.history];
            history[existingIndex] = historyEntry;
          } else {
            history = [historyEntry, ...s.history].slice(0, 100);
          }
          return {
            history,
            batches: {
              ...s.batches,
              [batchId]: {
                ...batch,
                status: 'failed',
                error,
                completedAt: Date.now(),
                historyId,
              },
            },
            // 失败时不更新 lastCompleteBatchId，保留上一次完整批次用于展示
            tabs: s.tabs.map((tab) =>
              tab.id === batch.tabId && isLatest
                ? { ...tab, latestBatchId: batchId }
                : tab,
            ),
          };
        });
      },

      /**
       * 批次取消：标记为 cancelled，不写结果。
       * 即使是最新批次，取消后也不展示结果（回退到上一次完整批次）。
       */
      cancelBatch: (batchId) => {
        const state = get();
        const batch = state.batches[batchId];
        if (!batch || batch.status !== 'running') return;
        set((s) => ({
          batches: {
            ...s.batches,
            [batchId]: { ...batch, status: 'cancelled', completedAt: Date.now() },
          },
        }));
      },

      getLatestBatch: (tabId) => {
        const state = get();
        const batchId = state.latestBatchByTab[tabId];
        return batchId ? state.batches[batchId] : undefined;
      },

      /**
       * 获取标签下应展示结果的批次：
       * - 最新批次成功 → 展示其结果
       * - 最新批次运行中 → 展示运行中（UI 可同时展示上一次结果）
       * - 最新批次失败/取消 → 回退到上一次完整批次
       */
      getDisplayedBatch: (tabId) => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab) return undefined;
        const latest = tab.latestBatchId ? state.batches[tab.latestBatchId] : undefined;
        if (latest?.status === 'success') return latest;
        if (latest?.status === 'running') return latest;
        // 失败/取消/无批次：回退到上一次完整批次
        const lastComplete = tab.lastCompleteBatchId
          ? state.batches[tab.lastCompleteBatchId]
          : undefined;
        return lastComplete?.status === 'success' ? lastComplete : undefined;
      },

      /**
       * 数据源版本变化：递增版本号。
       * 版本变化后，未固定的展示结果失效（UI 层判定 stale），
       * 历史继续保留原结果和依据版本。
       */
      bumpDataVersion: () =>
        set((state) => ({
          dataVersion: state.dataVersion + 1,
          dataVersionLabel: `快照 v${state.dataVersion + 1}`,
        })),

      /**
       * 基于旧批次重新计算：用相同 SQL、当前版本创建新批次。
       * 旧批次保留在历史中（不可变）。
       */
      recomputeBatch: (batchId) => {
        const state = get();
        const batch = state.batches[batchId];
        if (!batch) return undefined;
        return get().submitBatch(batch.tabId, batch.sql);
      },
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: safeStorage,
      partialize: (state): Partial<WorkbenchState> => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        history: state.history,
        favorites: state.favorites,
        dataVersion: state.dataVersion,
        dataVersionLabel: state.dataVersionLabel,
        batches: state.batches,
        latestBatchByTab: state.latestBatchByTab,
      }),
      /**
       * 迁移：为旧数据回填批次号和版本。
       * 缺少 batchId/dataVersion 的历史记录和标签，先回填再参与恢复。
       */
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<WorkbenchState>;
        if (version < 2) {
          // 回填数据源版本
          state.dataVersion = state.dataVersion ?? DATA_VERSION;
          state.dataVersionLabel = state.dataVersionLabel ?? DATA_VERSION_LABEL;
          // 回填批次记录
          state.batches = state.batches ?? {};
          state.latestBatchByTab = state.latestBatchByTab ?? {};
          // 回填历史记录的批次号和版本
          state.history = (state.history ?? []).map((entry) => ({
            ...entry,
            batchId: entry.batchId ?? `legacy-${entry.id}`,
            dataVersion: entry.dataVersion ?? DATA_VERSION,
            tabId: entry.tabId,
          }));
          // 回填标签的批次引用
          state.tabs = (state.tabs ?? []).map((tab) => ({
            ...tab,
            latestBatchId: tab.latestBatchId,
            lastCompleteBatchId: tab.lastCompleteBatchId,
          }));
        }
        return state as WorkbenchState;
      },
    },
  ),
);
