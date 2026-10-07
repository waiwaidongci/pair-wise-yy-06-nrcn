import {
  BookOutlined,
  CaretRightOutlined,
  FormatPainterOutlined,
  HistoryOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Input, Modal, Space, Tag, Tooltip } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryTabs } from '../components/QueryTabs';
import { ResultGrid } from '../components/ResultGrid';
import { SchemaTree } from '../components/SchemaTree';
import { SqlEditor } from '../components/SqlEditor';
import { getSchema } from '../data/mockDatabase';
import { onStorageRollback } from '../stores/resilientStorage';
import { useWorkbenchStore } from '../stores/workbenchStore';
import type { BatchRecord, QueryErrorDetail } from '../types/sql';
import { formatSql } from '../utils/sqlFormatter';
import { ERROR_MAPPINGS, toQueryErrorDetail } from '../utils/queryErrors';

export function WorkbenchPage() {
  const { message } = AntdApp.useApp();
  const tabs = useWorkbenchStore((state) => state.tabs);
  const activeTabId = useWorkbenchStore((state) => state.activeTabId);
  const dataVersion = useWorkbenchStore((state) => state.dataVersion);
  const batches = useWorkbenchStore((state) => state.batches);
  const addTab = useWorkbenchStore((state) => state.addTab);
  const closeTab = useWorkbenchStore((state) => state.closeTab);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const updateTab = useWorkbenchStore((state) => state.updateTab);
  const submitBatch = useWorkbenchStore((state) => state.submitBatch);
  const retryBatch = useWorkbenchStore((state) => state.retryBatch);
  const cancelBatch = useWorkbenchStore((state) => state.cancelBatch);
  const addFavorite = useWorkbenchStore((state) => state.addFavorite);
  const [favoriteOpen, setFavoriteOpen] = useState(false);
  const [favoriteName, setFavoriteName] = useState('');

  const schemaQuery = useQuery({ queryKey: ['database-schema'], queryFn: getSchema });
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  const batchById = useMemo(() => new Map(batches.map((batch) => [batch.id, batch])), [batches]);
  const runningBatch = activeTab?.runningBatchId
    ? batchById.get(activeTab.runningBatchId)
    : undefined;
  const lastBatch = activeTab?.lastBatchId ? batchById.get(activeTab.lastBatchId) : undefined;
  const snapshotBatch = activeTab?.snapshotBatchId
    ? batchById.get(activeTab.snapshotBatchId)
    : undefined;

  const autoRecomputeGuard = useRef(new Set<string>());
  const lastRunningIdRef = useRef<string | undefined>(undefined);
  const batchesRef = useRef(batches);
  batchesRef.current = batches;

  // 活动标签批次从 running 变为成功且截断时提示（执行器在 App 层全局运行）
  useEffect(() => {
    const running = batches.find(
      (batch) => batch.id === activeTab?.runningBatchId && batch.status === 'running',
    );
    if (running) {
      lastRunningIdRef.current = running.id;
      return;
    }
    const justSettledId = lastRunningIdRef.current;
    if (justSettledId) {
      const settled = batchesRef.current.find((batch) => batch.id === justSettledId);
      lastRunningIdRef.current = undefined;
      if (
        settled?.status === 'succeeded' &&
        settled.result?.truncated &&
        settled.tabId === activeTab?.id
      ) {
        void message.warning(
          `批次 ${settled.id.slice(0, 8)} 结果超过 LIMIT，已返回前 ${settled.result.rowCount} 行`,
        );
      }
    }
  }, [batches, activeTab?.id, activeTab?.runningBatchId, message]);

  // 写入失败回滚提示
  useEffect(
    () =>
      onStorageRollback((hadLastGood) => {
        void (hadLastGood
          ? message.error('持久化写入失败，已恢复上一次完整批次')
          : message.error('持久化写入失败，本次结果未保留'));
      }),
    [message],
  );

  // 版本刷新 / 重启恢复后，未固定的结果自动按新版本重算（每标签仅自动一次）
  useEffect(() => {
    if (!activeTab || activeTab.runningBatchId) return;
    if (activeTab.needsRecompute && activeTab.sql.trim() && !autoRecomputeGuard.current.has(activeTab.id)) {
      autoRecomputeGuard.current.add(activeTab.id);
      const id = submitBatch(activeTab.id);
      if (id) void message.info(`数据源版本 ${dataVersion}：已自动提交重算批次`);
    }
  }, [activeTab, submitBatch, dataVersion, message]);

  if (!activeTab) return null;

  const running = Boolean(runningBatch);
  const sql = activeTab.sql;
  const failedBatch =
    lastBatch?.status === 'failed' && lastBatch.errorMessage && lastBatch.sql === sql
      ? lastBatch
      : null;
  const errorForEditor: QueryErrorDetail | null = failedBatch
    ? toQueryErrorDetail(
        Object.assign(new Error(failedBatch.errorMessage), {
          code: failedBatch.errorCode,
        }),
        failedBatch.sql,
      )
    : null;
  const errorTitle = errorForEditor ? ERROR_MAPPINGS[errorForEditor.code]?.title ?? '执行失败' : '';

  const complexity = useMemo(
    () => ({
      lines: sql.split('\n').length,
      chars: sql.length,
      hasLimit: /\blimit\b/i.test(sql),
    }),
    [sql],
  );

  const execute = () => {
    const id = submitBatch(activeTab.id);
    if (id) autoRecomputeGuard.current.add(activeTab.id);
  };

  const cancel = () => {
    if (runningBatch) {
      cancelBatch(runningBatch.id);
      void message.info('已发送取消请求，该批次结果不会写回');
    }
  };

  const recompute = () => {
    if (runningBatch) return;
    const id = lastBatch ? retryBatch(lastBatch.id) : submitBatch(activeTab.id);
    if (id) autoRecomputeGuard.current.add(activeTab.id);
  };

  const runFormat = () => {
    updateTab(activeTab.id, formatSql(activeTab.sql));
  };

  const useTable = (tableName: string) => {
    const table = schemaQuery.data?.tables.find((item) => item.name === tableName);
    if (!table) return;
    const nextSql = `SELECT *\nFROM ${table.name}\nLIMIT 500;`;
    updateTab(activeTab.id, nextSql, table.name);
  };

  const staleSnapshot =
    !running &&
    snapshotBatch?.status === 'succeeded' &&
    snapshotBatch.dataVersion !== dataVersion;

  const notice = deriveNotice({
    runningBatch,
    lastBatch,
    snapshotBatch,
    currentVersion: dataVersion,
    stale: Boolean(staleSnapshot),
    onRecompute: recompute,
  });

  return (
    <div className="workbench">
      <SchemaTree
        schema={schemaQuery.data}
        loading={schemaQuery.isLoading}
        onUseTable={useTable}
      />
      <main className="query-main">
        <section className="editor-panel">
          <QueryTabs
            tabs={tabs}
            batches={batches}
            activeTabId={activeTab.id}
            currentVersion={dataVersion}
            onActivate={activateTab}
            onAdd={() => addTab()}
            onClose={closeTab}
          />
          <div className="editor-toolbar">
            <Space size={6}>
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                loading={running}
                onClick={execute}
              >
                执行
              </Button>
              <Tooltip title="查询执行中可取消">
                <Button
                  danger
                  icon={<StopOutlined />}
                  disabled={!running}
                  onClick={cancel}
                >
                  取消
                </Button>
              </Tooltip>
              <Tooltip title="依据当前数据源版本重新执行最近批次">
                <Button
                  icon={<ReloadOutlined />}
                  disabled={running}
                  onClick={recompute}
                >
                  按新版本重算
                </Button>
              </Tooltip>
              <Button icon={<FormatPainterOutlined />} onClick={runFormat}>
                格式化
              </Button>
              <Button
                icon={<BookOutlined />}
                onClick={() => {
                  setFavoriteName(`收藏 ${useWorkbenchStore.getState().favorites.length + 1}`);
                  setFavoriteOpen(true);
                }}
              >
                收藏
              </Button>
            </Space>
            <Space size={16} className="editor-meta">
              <span>
                <HistoryOutlined /> {complexity.lines} 行 / {complexity.chars} 字符
              </span>
              <span className={complexity.hasLimit ? 'meta-ok' : 'meta-warn'}>
                {complexity.hasLimit ? '已设置 LIMIT' : '建议设置 LIMIT'}
              </span>
              <Tooltip title="每个执行批次提交时固定该版本">
                <Tag color="blue">数据源 {dataVersion}</Tag>
              </Tooltip>
              <kbd>⌘ Enter</kbd>
            </Space>
          </div>
          {errorForEditor && (
            <Alert
              closable
              showIcon
              type="error"
              message={`${errorTitle} [${errorForEditor.code}] 第 ${errorForEditor.line} 行，第 ${errorForEditor.column} 列${
                lastBatch ? ` · 批次 ${lastBatch.id.slice(0, 8)}` : ''
              }`}
              description={`${errorForEditor.message} ${errorForEditor.hint}`}
            />
          )}
          <div className="editor-wrap">
            <SqlEditor
              key={activeTab.id}
              value={activeTab.sql}
              schema={schemaQuery.data}
              error={errorForEditor}
              onChange={(nextSql) => updateTab(activeTab.id, nextSql)}
              onExecute={execute}
              onFormat={runFormat}
            />
          </div>
        </section>
        <ResultGrid
          result={snapshotBatch?.result ?? null}
          resultRetained={Boolean(snapshotBatch?.resultRetained && snapshotBatch.result)}
          loading={running}
          runningBatch={runningBatch}
          notice={notice}
          currentVersion={dataVersion}
          onRecompute={recompute}
        />
      </main>
      <Modal
        open={favoriteOpen}
        title="收藏当前查询"
        okText="保存收藏"
        cancelText="取消"
        onCancel={() => setFavoriteOpen(false)}
        onOk={() => {
          if (!favoriteName.trim()) {
            void message.warning('请输入收藏名称');
            return;
          }
          addFavorite(favoriteName, activeTab.sql);
          setFavoriteOpen(false);
          void message.success('查询已收藏');
        }}
      >
        <Input
          autoFocus
          value={favoriteName}
          placeholder="例如：华东区高金额订单"
          onChange={(event) => setFavoriteName(event.target.value)}
          onPressEnter={() => {
            addFavorite(favoriteName, activeTab.sql);
            setFavoriteOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}

interface NoticeInput {
  runningBatch?: BatchRecord;
  lastBatch?: BatchRecord;
  snapshotBatch?: BatchRecord;
  currentVersion: string;
  stale: boolean;
  onRecompute: () => void;
}

interface GridNotice {
  type: 'stale' | 'canceled' | 'superseded' | 'failed' | 'empty';
  title: string;
  detail: string;
  version?: string;
  batchId?: string;
}

function deriveNotice(input: NoticeInput): GridNotice | null {
  const { runningBatch, lastBatch, snapshotBatch, currentVersion, stale } = input;
  if (runningBatch) {
    return {
      type: 'stale',
      title: `批次 ${runningBatch.id.slice(0, 8)} 执行中`,
      detail: `已固定查询语句与数据源版本 ${runningBatch.dataVersion}`,
      version: runningBatch.dataVersion,
      batchId: runningBatch.id,
    };
  }
  if (stale && snapshotBatch) {
    return {
      type: 'stale',
      title: `当前快照依据旧版本 ${snapshotBatch.dataVersion}（当前 ${currentVersion}）`,
      detail: '结果保留原批次数据，点击「按新版本重算」获取最新结果',
      version: snapshotBatch.dataVersion,
      batchId: snapshotBatch.id,
    };
  }
  if (!lastBatch) {
    return { type: 'empty', title: '执行查询后，结果将在这里显示', detail: '' };
  }
  if (lastBatch.status === 'canceled') {
    return {
      type: 'canceled',
      title: `批次 ${lastBatch.id.slice(0, 8)} 已取消`,
      detail: lastBatch.errorMessage ?? '取消的批次不会写回结果，可重新执行',
      batchId: lastBatch.id,
    };
  }
  if (lastBatch.status === 'superseded') {
    return {
      type: 'superseded',
      title: `批次 ${lastBatch.id.slice(0, 8)} 已失效`,
      detail:
        lastBatch.errorMessage ??
        `旧批次依据版本 ${lastBatch.dataVersion}，其晚到结果已被拒绝写回`,
      version: lastBatch.dataVersion,
      batchId: lastBatch.id,
    };
  }
  if (lastBatch.status === 'failed') {
    return {
      type: 'failed',
      title: `批次 ${lastBatch.id.slice(0, 8)} 执行失败`,
      detail: lastBatch.errorMessage ?? '未知错误',
      batchId: lastBatch.id,
    };
  }
  return null;
}
