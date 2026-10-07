import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import { Badge, Button, Tabs } from 'antd';
import type { BatchStatus, QuerySession } from '../types/sql';

interface QueryTabsProps {
  tabs: QuerySession[];
  activeTabId: string;
  statusByTab?: Record<string, BatchStatus | undefined>;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}

type BadgeStatus = 'success' | 'processing' | 'error' | 'default' | 'warning';

const STATUS_COLOR: Record<BatchStatus, BadgeStatus> = {
  running: 'processing',
  success: 'success',
  failed: 'error',
  cancelled: 'default',
};

export function QueryTabs({
  tabs,
  activeTabId,
  statusByTab,
  onActivate,
  onAdd,
  onClose,
}: QueryTabsProps) {
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
          const status = statusByTab?.[tab.id];
          return {
            key: tab.id,
            label: (
              <span className="tab-label">
                {status ? (
                  <Badge status={STATUS_COLOR[status]} className="tab-status-badge" />
                ) : (
                  <span className="tab-status" />
                )}
                {tab.title}
              </span>
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
