export type SqlValue = string | number | null;

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
  /** 结果依据的数据源版本（与执行批次固定的版本一致） */
  dataVersion: string;
}

/** 数据源版本描述：series 为第几代数据，digest 为内容指纹 */
export interface DataSourceVersion {
  series: number;
  digest: string;
  /** 稳定版本标识，例如 v3-a1b2c3d4 */
  id: string;
  refreshedAt: number;
}

/**
 * 执行批次生命周期：
 * - running：已提交，查询语句与数据源版本已固定
 * - succeeded / failed：正常终态，结果（或错误）只写回标签当前批次
 * - canceled：用户主动取消
 * - superseded：提交后被同标签更新批次取代，或执行期间数据源版本刷新
 * - recovered：写入持久层失败后回滚，恢复上一次完整批次时使用的标记
 */
export type BatchStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'superseded'
  | 'recovered';

export interface BatchRecord {
  /** 批次号：提交时生成，重试同一批次沿用同一 ID（幂等键） */
  id: string;
  tabId: string;
  /** 提交时固定的查询语句 */
  sql: string;
  /** 提交时固定的数据源版本 */
  dataVersion: string;
  status: BatchStatus;
  submittedAt: number;
  finishedAt?: number;
  elapsedMs?: number;
  result?: QueryResult;
  errorCode?: string;
  errorMessage?: string;
  /** result 行数据是否仍完整保留在持久化记录中（历史精简时为 false） */
  resultRetained: boolean;
  /** 旧数据迁移回填标记 */
  backfilled?: boolean;
  /** 来源批次：被取代/恢复链路上一个批次号 */
  supersededFrom?: string;
}

export interface QuerySession {
  id: string;
  title: string;
  sql: string;
  updatedAt: number;
  /** 当前在飞批次；同一标签只有它能写回结果 */
  runningBatchId?: string;
  /** 最近一次终态批次（成功 / 失败 / 取消 / 被取代） */
  lastBatchId?: string;
  /** 最近一次成功写回的结果快照批次；只在成功批次完成时移动 */
  snapshotBatchId?: string;
  /** 版本刷新后未固定的结果需要重算 */
  needsRecompute: boolean;
}

/** 历史页批量结构由批次账本派生，保留旧类型仅供迁移使用 */
export interface LegacyHistoryEntry {
  id: string;
  sql: string;
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
