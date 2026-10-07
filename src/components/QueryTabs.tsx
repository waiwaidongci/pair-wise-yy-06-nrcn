import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Tabs, Tooltip } from 'antd';
import type { BatchRecord, QuerySession } from '../types/sql';

interface QueryTabsProps {
  tabs: QuerySession[];
  batches: BatchRecord[];
  activeTabId: string;
  currentVersion: string;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  running: { color: '#1677ff', label: '批次执行中' },
  succeeded: { color: '#34c38f', label: '最近批次成功' },
  failed: { color: '#f5222d', label: '最近批次失败' },
  canceled: { color: '#faad14', label: '最近批次已取消' },
  superseded: { color: '#8c8c8c', label: '旧批次已失效' },
};

export function QueryTabs({
  tabs,
  batches,
  activeTabId,
  currentVersion,
  onActivate,
  onAdd,
  onClose,
}: QueryTabsProps) {
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  return (
    <div className="query-tabs">
      <Tabs
        activeKey={activeTabId}
        onChange={onActivate}
        onEdit={(key, action) => {
          if (action === 'add') onAdd();
          if (action === 'remove') onClose(String(key));
        }}
        type="editable-card"
        hideAdd
        items={tabs.map((tab) => {
          const running = tab.runningBatchId ? batchById.get(tab.runningBatchId) : undefined;
          const last = tab.lastBatchId ? batchById.get(tab.lastBatchId) : undefined;
          const snapshot = tab.snapshotBatchId
            ? batchById.get(tab.snapshotBatchId)
            : undefined;
          const effective = running ?? last;
          const meta = effective ? (STATUS_META[effective.status] ?? STATUS_META.succeeded) : null;
          const stale =
            !running &&
            snapshot?.status === 'succeeded' &&
            snapshot.dataVersion !== currentVersion;
          const tooltipParts = [
            running ? `在飞批次 ${running.id.slice(0, 8)} · 固定版本 ${running.dataVersion}` : null,
            !running && last ? `最近批次 ${last.id.slice(0, 8)} · ${last.status}` : null,
            stale && snapshot ? `快照版本 ${snapshot.dataVersion}，当前 ${currentVersion}` : null,
            tab.needsRecompute ? '未固定结果，待重算' : null,
          ].filter(Boolean);

          return {
            key: tab.id,
            label: (
              <Tooltip title={tooltipParts.join(' ｜ ')} mouseEnterDelay={0.4}>
                <span className="tab-label">
                  <span
                    className={`tab-status${running ? ' tab-status--running' : ''}${stale ? ' tab-status--stale' : ''}`}
                    style={meta && !running && !stale ? { background: meta.color } : undefined}
                  />
                  {tab.title}
                  {stale && <span className="tab-stale-dot" title="快照依据旧版本" />}
                </span>
              </Tooltip>
            ),
            closable: true,
          };
        })}
      />
      <Button
        type="text"
        className="add-query-tab"
        icon={<PlusOutlined />}
        title="新建查询标签"
        onClick={onAdd}
      />
      <span className="query-tabs__spacer" />
      <Button
        type="text"
        icon={<CloseOutlined />}
        title="关闭当前标签"
        onClick={() => onClose(activeTabId)}
      />
    </div>
  );
}
