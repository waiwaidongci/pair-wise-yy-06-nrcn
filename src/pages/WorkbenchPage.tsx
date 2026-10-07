import {
  BookOutlined,
  CaretRightOutlined,
  FormatPainterOutlined,
  HistoryOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Input, Modal, Space, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryTabs } from '../components/QueryTabs';
import { ResultGrid } from '../components/ResultGrid';
import { SchemaTree } from '../components/SchemaTree';
import { SqlEditor } from '../components/SqlEditor';
import { executeMockQuery, getSchema } from '../data/mockDatabase';
import { useWorkbenchStore } from '../stores/workbenchStore';
import type { BatchStatus, QueryErrorDetail } from '../types/sql';
import { formatSql } from '../utils/sqlFormatter';
import { ERROR_MAPPINGS, toQueryErrorDetail } from '../utils/queryErrors';

export function WorkbenchPage() {
  const { message } = AntdApp.useApp();
  const tabs = useWorkbenchStore((state) => state.tabs);
  const activeTabId = useWorkbenchStore((state) => state.activeTabId);
  const addTab = useWorkbenchStore((state) => state.addTab);
  const closeTab = useWorkbenchStore((state) => state.closeTab);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const updateTab = useWorkbenchStore((state) => state.updateTab);
  const addFavorite = useWorkbenchStore((state) => state.addFavorite);
  const submitBatch = useWorkbenchStore((state) => state.submitBatch);
  const completeBatch = useWorkbenchStore((state) => state.completeBatch);
  const failBatch = useWorkbenchStore((state) => state.failBatch);
  const cancelBatch = useWorkbenchStore((state) => state.cancelBatch);
  const recomputeBatch = useWorkbenchStore((state) => state.recomputeBatch);
  const bumpDataVersion = useWorkbenchStore((state) => state.bumpDataVersion);
  const dataVersion = useWorkbenchStore((state) => state.dataVersion);
  const dataVersionLabel = useWorkbenchStore((state) => state.dataVersionLabel);
  const batches = useWorkbenchStore((state) => state.batches);
  const latestBatchByTab = useWorkbenchStore((state) => state.latestBatchByTab);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const schemaQuery = useQuery({ queryKey: ['database-schema'], queryFn: getSchema });

  // 每个标签独立的 AbortController
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const [favoriteOpen, setFavoriteOpen] = useState(false);
  const [favoriteName, setFavoriteName] = useState('');
  const [lastExecutedSql, setLastExecutedSql] = useState('');

  // 从 store 派生当前标签的批次状态
  const latestBatchId = activeTab ? latestBatchByTab[activeTab.id] : undefined;
  const latestBatch = latestBatchId ? batches[latestBatchId] : undefined;
  const displayedBatch = activeTab
    ? (() => {
        const tab = tabs.find((t) => t.id === activeTab.id);
        if (!tab) return undefined;
        const latest = tab.latestBatchId ? batches[tab.latestBatchId] : undefined;
        if (latest?.status === 'success') return latest;
        if (latest?.status === 'running') return latest;
        const lastComplete = tab.lastCompleteBatchId
          ? batches[tab.lastCompleteBatchId]
          : undefined;
        return lastComplete?.status === 'success' ? lastComplete : undefined;
      })()
    : undefined;

  const result =
    displayedBatch && displayedBatch.status === 'success' && displayedBatch.result
      ? displayedBatch.result
      : null;
  const error = latestBatch && latestBatch.status === 'failed' ? latestBatch.error : null;
  const running = latestBatch?.status === 'running';
  // 展示的结果是否已过期（数据版本变化后未固定的结果失效）
  const stale = displayedBatch
    ? displayedBatch.dataVersion !== dataVersion
    : false;

  const executeMutation = useMutation({
    mutationFn: ({ sql, signal }: { sql: string; signal: AbortSignal }) =>
      executeMockQuery(sql, signal),
  });

  const errorTitle = error ? ERROR_MAPPINGS[error.code]?.title ?? '执行失败' : '';

  // 每个标签的最新批次状态
  const statusByTab = useMemo(() => {
    const result: Record<string, BatchStatus | undefined> = {};
    tabs.forEach((tab) => {
      const batchId = latestBatchByTab[tab.id];
      const batch = batchId ? batches[batchId] : undefined;
      result[tab.id] = batch?.status;
    });
    return result;
  }, [tabs, latestBatchByTab, batches]);

  const complexity = useMemo(() => {
    const sql = activeTab?.sql ?? '';
    return {
      lines: sql.split('\n').length,
      chars: sql.length,
      hasLimit: /\blimit\b/i.test(sql),
    };
  }, [activeTab?.sql]);

  // 组件卸载时取消所有运行中的查询
  useEffect(() => {
    const controllers = abortControllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  if (!activeTab) return null;

  const execute = async () => {
    const sql = activeTab.sql.trim();
    // 如果该标签有正在运行的旧批次，先取消它（同一标签只接受最新批次）
    if (running && latestBatch) {
      const oldController = abortControllersRef.current.get(activeTab.id);
      if (oldController) {
        oldController.abort();
      }
      cancelBatch(latestBatch.id);
    }
    // 提交批次：固定查询语句与数据源版本
    const batch = submitBatch(activeTab.id, sql);
    setLastExecutedSql(sql);

    const controller = new AbortController();
    abortControllersRef.current.set(activeTab.id, controller);

    try {
      const nextResult = await executeMutation.mutateAsync({
        sql,
        signal: controller.signal,
      });
      // 仅当该批次仍是最新批次时才写入结果
      completeBatch(batch.id, nextResult);
      if (nextResult.truncated) {
        void message.warning(`结果超过 LIMIT，已返回前 ${nextResult.rowCount} 行`);
      }
    } catch (queryError) {
      const detail = toQueryErrorDetail(queryError, sql);
      if (detail.code === 'QUERY_ABORTED') {
        // 取消的请求不写结果
        cancelBatch(batch.id);
        void message.info('已取消查询');
      } else {
        failBatch(batch.id, detail);
      }
    } finally {
      abortControllersRef.current.delete(activeTab.id);
    }
  };

  const cancel = () => {
    const controller = abortControllersRef.current.get(activeTab.id);
    if (controller) {
      controller.abort();
      // catch 块会调用 cancelBatch
    } else {
      // 没有进行中的请求，直接标记取消
      if (latestBatch?.status === 'running') {
        cancelBatch(latestBatch.id);
      }
    }
  };

  const recompute = () => {
    if (!displayedBatch) return;
    const newBatch = recomputeBatch(displayedBatch.id);
    if (!newBatch) return;
    // 用新批次执行
    const controller = new AbortController();
    abortControllersRef.current.set(activeTab.id, controller);
    executeMutation
      .mutateAsync({ sql: newBatch.sql, signal: controller.signal })
      .then((nextResult) => {
        completeBatch(newBatch.id, nextResult);
      })
      .catch((queryError) => {
        const detail = toQueryErrorDetail(queryError, newBatch.sql);
        if (detail.code === 'QUERY_ABORTED') {
          cancelBatch(newBatch.id);
        } else {
          failBatch(newBatch.id, detail);
        }
      })
      .finally(() => {
        abortControllersRef.current.delete(activeTab.id);
      });
  };

  const runFormat = () => {
    updateTab(activeTab.id, formatSql(activeTab.sql));
  };

  const useTable = (tableName: string) => {
    const table = schemaQuery.data?.tables.find((item) => item.name === tableName);
    if (!table) return;
    const sql = `SELECT *\nFROM ${table.name}\nLIMIT 500;`;
    updateTab(activeTab.id, sql, table.name);
  };

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
            activeTabId={activeTab.id}
            statusByTab={statusByTab}
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
                onClick={() => void execute()}
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
              <Tooltip title="数据源版本：结果依据此版本固定，版本变化后未固定结果失效">
                <Tag icon={<SyncOutlined />} color={stale ? 'warning' : 'default'}>
                  数据版本 v{dataVersion}
                </Tag>
              </Tooltip>
              <Button
                type="text"
                size="small"
                onClick={() => {
                  bumpDataVersion();
                  void message.info('数据源版本已更新，未固定的结果已失效');
                }}
              >
                刷新数据
              </Button>
              <span>
                <HistoryOutlined /> {complexity.lines} 行 / {complexity.chars} 字符
              </span>
              <span className={complexity.hasLimit ? 'meta-ok' : 'meta-warn'}>
                {complexity.hasLimit ? '已设置 LIMIT' : '建议设置 LIMIT'}
              </span>
              <kbd>⌘ Enter</kbd>
            </Space>
          </div>
          {error && (
            <Alert
              closable
              showIcon
              type="error"
              message={`${errorTitle} [${error.code}] 第 ${error.line} 行，第 ${error.column} 列`}
              description={`${error.message} ${error.hint}`}
              onClose={() => {
                // 清除当前批次的错误展示（不删除批次记录）
                if (latestBatch?.status === 'failed') {
                  // 通过提交空操作清除错误状态：标记为已取消
                  cancelBatch(latestBatch.id);
                }
              }}
            />
          )}
          {stale && result && (
            <Alert
              showIcon
              type="warning"
              message="数据源版本已更新，当前结果可能过期"
              description={
                <span>
                  结果依据 v{displayedBatch?.dataVersion} · {dataVersionLabel}，当前版本 v{dataVersion}。
                  <Button type="link" size="small" onClick={recompute}>
                    重新执行以刷新结果
                  </Button>
                </span>
              }
            />
          )}
          <div className="editor-wrap">
            <SqlEditor
              key={activeTab.id}
              value={activeTab.sql}
              schema={schemaQuery.data}
              error={error}
              onChange={(sql) => updateTab(activeTab.id, sql)}
              onExecute={() => void execute()}
              onFormat={runFormat}
            />
          </div>
        </section>
        <ResultGrid
          result={result}
          loading={running}
          error={error?.message ?? null}
          batchId={displayedBatch?.id}
          dataVersion={displayedBatch?.dataVersion}
          currentDataVersion={dataVersion}
          stale={stale}
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
      {lastExecutedSql && (
        <div className="execution-footprint" aria-hidden="true">
          {lastExecutedSql.slice(0, 80)}
        </div>
      )}
    </div>
  );
}
