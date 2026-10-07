import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * 带回滚能力的 localStorage 存储：
 * - 每次成功写入后记录「上一次完整批次」的序列化快照；
 * - 写入失败时（配额、拒绝写入或故障注入）恢复上一份完整快照；
 * - 故障注入开关供演示与验证恢复链路使用。
 *
 * ResilientLocalStorage 是原始字符串存储；外层 createJSONStorage 负责
 * zustand 状态对象与 JSON 字符串之间的转换。
 */

const ROLLBACK_FLAG = 'pair-wise-yy-06-next-write-fails';

let failNextWrite = false;

try {
  failNextWrite = window.localStorage.getItem(ROLLBACK_FLAG) === '1';
} catch {
  failNextWrite = false;
}

/** 安排下一次持久化写入失败，用于验证写失败回滚 */
export function armNextWriteFailure(): void {
  failNextWrite = true;
  try {
    window.localStorage.setItem(ROLLBACK_FLAG, '1');
  } catch {
    // 标志本身写不进去时，内存开关仍在当前会话生效
  }
}

function disarmNextWriteFailure(): void {
  failNextWrite = false;
  try {
    window.localStorage.removeItem(ROLLBACK_FLAG);
  } catch {
    // 忽略
  }
}

type RollbackListener = (reverted: boolean) => void;
const rollbackListeners = new Set<RollbackListener>();

export function onStorageRollback(listener: RollbackListener): () => void {
  rollbackListeners.add(listener);
  return () => rollbackListeners.delete(listener);
}

function notifyRollback(reverted: boolean): void {
  rollbackListeners.forEach((listener) => listener(reverted));
}

class ResilientLocalStorage implements StateStorage {
  /** 最近一次写入成功的完整序列化状态；null 表示尚无已落盘版本 */
  private lastGood: string | null;

  constructor() {
    this.lastGood = this.readRaw();
  }

  private readRaw(): string | null {
    try {
      return window.localStorage.getItem('pair-wise-yy-06-workbench');
    } catch {
      return null;
    }
  }

  getItem(name: string): string | null {
    void name;
    return this.readRaw();
  }

  setItem(name: string, value: string): void {
    const previous = this.lastGood ?? this.readRaw();
    if (failNextWrite) {
      disarmNextWriteFailure();
      this.restore(name, previous);
      throw new Error('模拟持久化写入失败：已安排的写入故障');
    }
    try {
      window.localStorage.setItem(name, value);
      // 读回校验：确认完整快照真正落盘，再提升 lastGood
      const verified = window.localStorage.getItem(name);
      if (verified !== value) {
        throw new Error('持久化写入校验失败：读回内容与写入不一致');
      }
      this.lastGood = value;
    } catch (error) {
      this.restore(name, previous);
      const wrapped = error instanceof Error ? error : new Error('持久化写入失败');
      // zustand 在部分版本中不会消费存储层拒绝；延后抛出使其进入全局错误兜底，
      // 而不是产生未处理的 Promise rejection。真正的状态恢复已在 restore() 完成。
      window.setTimeout(() => {
        window.dispatchEvent?.(
          new CustomEvent('workbench:storage-write-failed', { detail: wrapped.message }),
        );
      }, 0);
      throw wrapped;
    }
  }

  removeItem(name: string): void {
    window.localStorage.removeItem(name);
    this.lastGood = null;
  }

  /** 恢复上一次完整批次；没有历史版本时清空（仍为一致状态） */
  private restore(name: string, previous: string | null): void {
    try {
      if (previous === null) {
        window.localStorage.removeItem(name);
      } else {
        window.localStorage.setItem(name, previous);
      }
    } catch {
      // localStorage 彻底不可用，内存状态仍可继续工作
    }
    notifyRollback(previous !== null);
  }
}

/** zustand persist 使用的 JSON 包装存储（带回滚能力） */
export const resilientStateStorage = createJSONStorage(() => new ResilientLocalStorage());
