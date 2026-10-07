import { useEffect } from 'react';
import { executeMockQuery } from '../data/mockDatabase';
import {
  getAbortReason,
  registerBatch,
  unregisterBatch,
} from '../stores/executionRegistry';
import { useWorkbenchStore } from '../stores/workbenchStore';
import type { BatchRecord } from '../types/sql';
import { SqlQueryError } from '../utils/queryErrors';

/**
 * 全局批次执行器：监听账本中所有 running 批次并实际执行查询。
 * 批次完成时调用 completeBatch，由 store 守卫决定能否写回
 * （同一标签只接受最新批次；取消、失败、晚到旧批次一律不盖结果）。
 */
export function useBatchExecutor(onSettled?: (batch: BatchRecord) => void): void {
  const batches = useWorkbenchStore((state) => state.batches);

  useEffect(() => {
    batches
      .filter((batch) => batch.status === 'running')
      .forEach((batch) => {
        if (registerToken.has(batch.id)) return;
        registerToken.add(batch.id);
        const signal = registerBatch(batch.id);

        const finishWithAbort = () => {
          const reason = getAbortReason(batch.id);
          if (reason === 'superseded' || reason === 'tab-closed') {
            useWorkbenchStore.getState().completeBatch(batch.id, {
              kind: 'superseded',
              message:
                reason === 'tab-closed'
                  ? '标签已关闭，在飞批次终止'
                  : '批次已被更新批次取代或数据源版本刷新，晚到结果拒绝写回',
            });
          } else {
            useWorkbenchStore.getState().completeBatch(batch.id, { kind: 'canceled' });
          }
        };

        void executeMockQuery(batch.sql, signal)
          .then((result) => {
            useWorkbenchStore.getState().completeBatch(batch.id, { kind: 'success', result });
          })
          .catch((error: unknown) => {
            // 终态守卫在 store 内：cancelBatch / 版本刷新 / 新批次提交
            // 都可能让该批次先变成终态，这里再 complete 会被直接忽略
            if (error instanceof SqlQueryError && error.code === 'QUERY_ABORTED') {
              finishWithAbort();
            } else if (error instanceof SqlQueryError && error.code === 'BATCH_SUPERSEDED') {
              useWorkbenchStore.getState().completeBatch(batch.id, {
                kind: 'superseded',
                message: error.message,
              });
            } else {
              useWorkbenchStore.getState().completeBatch(batch.id, {
                kind: 'error',
                code: error instanceof SqlQueryError ? error.code : 'QUERY_001',
                message: error instanceof Error ? error.message : '查询执行失败',
              });
            }
          })
          .finally(() => {
            registerToken.delete(batch.id);
            unregisterBatch(batch.id);
            const settled = useWorkbenchStore
              .getState()
              .batches.find((item) => item.id === batch.id);
            if (settled && settled.status !== 'running') onSettled?.(settled);
          });
      });
  }, [batches, onSettled]);
}

/**
 * 版本刷新 / 重启恢复后，未固定的结果按新版本自动重算。
 * activeTabId 对应的标签由工作台页面自行提示，其余所有标签静默并发重算。
 */
export function useAutoRecompute(exemptTabId?: string): void {
  const tabs = useWorkbenchStore((state) => state.tabs);
  useEffect(() => {
    tabs.forEach((tab) => {
      if (tab.id === exemptTabId) return;
      if (tab.runningBatchId || !tab.needsRecompute || !tab.sql.trim()) return;
      useWorkbenchStore.getState().submitBatch(tab.id);
    });
  }, [tabs, exemptTabId]);
}

const registerToken = new Set<string>();
