/**
 * 执行批次的运行时注册表：批次号 -> AbortController。
 * 不属于持久化状态——刷新页面后在飞批次一律按「已取消、待重算」恢复。
 */

export type AbortReason = 'user-canceled' | 'superseded' | 'tab-closed';

const controllers = new Map<string, AbortController>();
const reasons = new Map<string, AbortReason>();

export function registerBatch(batchId: string): AbortSignal {
  const existing = controllers.get(batchId);
  if (existing) return existing.signal;
  const controller = new AbortController();
  controllers.set(batchId, controller);
  reasons.delete(batchId);
  return controller.signal;
}

export function abortBatch(batchId: string, reason: AbortReason = 'user-canceled'): boolean {
  const controller = controllers.get(batchId);
  if (!controller) return false;
  reasons.set(batchId, reason);
  controller.abort(reason);
  return true;
}

export function getAbortReason(batchId: string): AbortReason | undefined {
  return reasons.get(batchId);
}

export function isBatchRunning(batchId: string): boolean {
  return controllers.has(batchId);
}

export function abortAllBatches(reason: AbortReason = 'superseded'): string[] {
  const ids = [...controllers.keys()];
  controllers.forEach((controller, id) => {
    reasons.set(id, reason);
    controller.abort(reason);
  });
  controllers.clear();
  return ids;
}

export function unregisterBatch(batchId: string): void {
  controllers.delete(batchId);
  reasons.delete(batchId);
}
