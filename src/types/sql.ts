export type SqlValue = string | number | null;

export type BatchStatus = 'running' | 'success' | 'failed' | 'cancelled';

/**
 * 执行批次：每次提交查询时固定查询语句与数据源版本，
 * 结果只允许写入该标签下最新的批次。
 */
export interface QueryBatch {
  id: string;
  tabId: string;
  /** 提交时固定的查询语句快照 */
  sql: string;
  /** 提交时固定的数据源版本 */
  dataVersion: number;
  status: BatchStatus;
  /** 成功时的结果快照 */
  result?: QueryResult;
  /** 失败时的错误详情 */
  error?: QueryErrorDetail;
  startedAt: number;
  completedAt?: number;
  /** 关联的历史记录 ID，重试时更新同一条而非追加 */
  historyId?: string;
}

/** 数据源版本快照 */
export interface DataSourceVersion {
  version: number;
  label: string;
  changedAt: number;
}

export interface ColumnSchema {
  name: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  nullable?: boolean;
  description?: string;
}

export interface TableSchema {
  name: string;
  label: string;
  description: string;
  columns: ColumnSchema[];
  rows: Array<Record<string, SqlValue>>;
}

export interface DatabaseSchema {
  name: string;
  label: string;
  tables: TableSchema[];
}

export interface QueryColumn {
  name: string;
  label: string;
  type: ColumnSchema['type'];
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, SqlValue>>;
  rowCount: number;
  totalMatched: number;
  elapsedMs: number;
  sql: string;
  truncated: boolean;
}

export interface QuerySession {
  id: string;
  title: string;
  sql: string;
  updatedAt: number;
  /** 该标签下最新的执行批次 ID */
  latestBatchId?: string;
  /** 最近一次成功的完整批次 ID，用于失败后恢复展示 */
  lastCompleteBatchId?: string;
}

export interface QueryHistoryEntry {
  id: string;
  /** 关联的执行批次 ID，重试时更新同一条而非追加重复记录 */
  batchId?: string;
  /** 所属标签 ID */
  tabId?: string;
  sql: string;
  /** 结果所依据的数据源版本（不可变快照） */
  dataVersion?: number;
  executedAt: number;
  elapsedMs: number;
  rowCount: number;
  success: boolean;
  error?: string;
}

export interface FavoriteQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
}

export interface QueryErrorDetail {
  code: string;
  message: string;
  hint: string;
  line: number;
  column: number;
}
