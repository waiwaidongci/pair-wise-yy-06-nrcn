import {
  ClockCircleOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  StarOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { App as AntdApp, Button, Empty, List, Popconfirm, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { armNextWriteFailure } from '../stores/resilientStorage';
import { useWorkbenchStore } from '../stores/workbenchStore';
import type { BatchRecord, BatchStatus } from '../types/sql';

const STATUS_TAG: Record<BatchStatus, { color: string; text: string }> = {
  running: { color: 'processing', text: '执行中' },
  succeeded: { color: 'green', text: '成功' },
  failed: { color: 'red', text: '失败' },
  canceled: { color: 'orange', text: '已取消' },
  superseded: { color: 'default', text: '已失效' },
  recovered: { color: 'purple', text: '已恢复' },
};

export function HistoryPage() {
  const { message } = AntdApp.useApp();
  const batches = useWorkbenchStore((state) => state.batches);
  const clearHistory = useWorkbenchStore((state) => state.clearHistory);
  const addTab = useWorkbenchStore((state) => state.addTab);
  const addFavorite = useWorkbenchStore((state) => state.addFavorite);
  const retryBatch = useWorkbenchStore((state) => state.retryBatch);
  const navigate = useNavigate();

  const sorted = [...batches].sort((a, b) => b.submittedAt - a.submittedAt);

  const openSql = (sql: string, favorite = false) => {
    if (favorite) {
      addFavorite(`历史收藏 ${Date.now().toString().slice(-4)}`, sql);
      void message.success('已加入收藏');
      return;
    }
    addTab(sql);
    navigate('/workbench');
  };

  return (
    <div className="content-page">
      <div className="content-page__heading">
        <div>
          <Typography.Title level={2}>查询历史</Typography.Title>
          <Typography.Text type="secondary">
            每条记录是一个可追溯的执行批次：固定查询语句与数据源版本，取消、失败或晚到的旧批次不会覆盖结果。
          </Typography.Text>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip title="安排下一次持久化写入失败，演示写入失败后恢复上一次完整批次；重试沿用同一批次号，不追加重复记录">
            <Button icon={<WarningOutlined />} onClick={() => {
              armNextWriteFailure();
              void message.warning('已安排：下一次批次写入将失败并回滚到上一次完整批次');
            }}>
              模拟写入失败
            </Button>
          </Tooltip>
          {batches.length > 0 && (
            <Popconfirm title="确认清空全部批次历史？" onConfirm={clearHistory}>
              <Button danger icon={<DeleteOutlined />}>
                清空历史
              </Button>
            </Popconfirm>
          )}
        </div>
      </div>
      <div className="content-card">
        {sorted.length ? (
          <List
            itemLayout="vertical"
            dataSource={sorted}
            renderItem={(item) => (
              <BatchHistoryItem
                key={item.id}
                item={item}
                onOpen={() => openSql(item.sql)}
                onFavorite={() => openSql(item.sql, true)}
                onRetry={() => {
                  const id = retryBatch(item.id);
                  if (id) {
                    navigate('/workbench');
                    void message.info(`沿用批次 ${id.slice(0, 8)} 重试，不追加重复记录`);
                  }
                }}
              />
            )}
          />
        ) : (
          <Empty description="执行 SQL 后，这里会记录批次号、依据版本、结果与耗时" />
        )}
      </div>
    </div>
  );
}

interface BatchHistoryItemProps {
  item: BatchRecord;
  onOpen: () => void;
  onFavorite: () => void;
  onRetry: () => void;
}

function BatchHistoryItem({ item, onOpen, onFavorite, onRetry }: BatchHistoryItemProps) {
  const tag = STATUS_TAG[item.status];
  return (
    <List.Item
      actions={[
        <Button key="open" type="link" icon={<PlayCircleOutlined />} onClick={onOpen}>
          在编辑器中打开
        </Button>,
        <Button key="favorite" type="link" icon={<StarOutlined />} onClick={onFavorite}>
          收藏
        </Button>,
        item.status !== 'running' && (
          <Button key="retry" type="link" icon={<RedoOutlined />} onClick={onRetry}>
            同批次重试
          </Button>
        ),
      ].filter(Boolean)}
    >
      <List.Item.Meta
        title={
          <span className="history-batch-title">
            <ClockCircleOutlined /> {new Date(item.submittedAt).toLocaleString('zh-CN')}
            <Tag color={tag.color} style={{ marginLeft: 10 }}>
              {tag.text}
            </Tag>
            {item.status === 'succeeded' && (
              <span className="muted-text">
                {item.result?.rowCount ?? 0} 行 · {item.elapsedMs ?? item.result?.elapsedMs ?? 0} ms
              </span>
            )}
            <Tooltip title="批次号：提交时生成，重试沿用同一 ID 做幂等去重">
              <Tag className="history-batch-id">#{item.id.slice(0, 8)}</Tag>
            </Tooltip>
            <Tooltip title="该批次提交时固定的数据源版本；历史永久保留该依据版本">
              <Tag color="blue">依据 {item.dataVersion}</Tag>
            </Tooltip>
            {item.backfilled && <Tag color="gold">旧记录已回填</Tag>}
          </span>
        }
        description={<pre className="sql-preview">{item.sql}</pre>}
      />
      {item.errorMessage && (
        <Typography.Text
          type={item.status === 'failed' ? 'danger' : 'secondary'}
          className="history-batch-note"
        >
          {item.errorMessage}
        </Typography.Text>
      )}
    </List.Item>
  );
}
