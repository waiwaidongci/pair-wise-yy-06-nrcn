import {
  CloudServerOutlined,
  CodeOutlined,
  HistoryOutlined,
  ReloadOutlined,
  StarOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Layout, Tag, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { getDataSourceVersion, subscribeDataSourceVersion } from './data/mockDatabase';
import { useAutoRecompute, useBatchExecutor } from './hooks/useBatchExecutor';
import { useWorkbenchStore } from './stores/workbenchStore';
import type { DataSourceVersion } from './types/sql';

const NAV_ITEMS = [
  { path: '/workbench', label: 'SQL 工作台', icon: <CodeOutlined /> },
  { path: '/history', label: '查询历史', icon: <HistoryOutlined /> },
  { path: '/favorites', label: '收藏查询', icon: <StarOutlined /> },
];

export function App() {
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const refreshDataVersion = useWorkbenchStore((state) => state.refreshDataVersion);
  const currentVersionId = useWorkbenchStore((state) => state.dataVersion);
  const activeTabId = useWorkbenchStore((state) => state.activeTabId);
  const [version, setVersion] = useState<DataSourceVersion>(() => getDataSourceVersion());
  const [refreshing, setRefreshing] = useState(false);

  // 全局批次执行器（多标签并发）；活动标签的自动重算提示在工作台页面处理
  useBatchExecutor();
  useAutoRecompute(location.pathname.startsWith('/workbench') ? activeTabId : undefined);

  useEffect(() => subscribeDataSourceVersion(setVersion), []);

  const current = NAV_ITEMS.find((item) => location.pathname.startsWith(item.path));

  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    // 先推进内存数据源版本（store 会中止在飞批次并标记旧快照过期），再刷新结构树缓存
    const nextId = refreshDataVersion();
    void queryClient.invalidateQueries({ queryKey: ['database-schema'] });
    setVersion(getDataSourceVersion());
    window.setTimeout(() => {
      setRefreshing(false);
      void message.success(
        `数据源已 ETL 刷新到 ${nextId}：在飞批次已中止，旧结果保留并按新版本重算`,
      );
    }, 300);
  };

  return (
    <Layout className="app-shell">
      <Layout.Sider width={220} className="app-sider">
        <div className="app-brand">
          <span className="app-brand__mark">
            <CloudServerOutlined />
          </span>
          <span>
            <strong>Nebula SQL</strong>
            <small>Data Workbench</small>
          </span>
        </div>
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => (isActive ? 'nav-item nav-item--active' : 'nav-item')}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="data-source-card">
          <span className="source-pulse" />
          <div>
            <strong>commerce_dw</strong>
            <small>
              第 {version.series + 1} 代 · {version.id}
            </small>
          </div>
          <Tag color="success">在线</Tag>
          <Tooltip title="模拟数据源 ETL 刷新：产生新版本，在飞批次失效并自动重算，历史保留原版本结果">
            <button
              type="button"
              className="data-source-refresh"
              disabled={refreshing}
              onClick={handleRefresh}
            >
              {refreshing ? <SyncOutlined spin /> : <ReloadOutlined />} 刷新数据
            </button>
          </Tooltip>
          <small className="data-source-current">工作台批次固定版本：{currentVersionId}</small>
        </div>
        <div className="sider-footer">
          <span>查询引擎 v1.5.0</span>
          <Tooltip title="所有数据和查询均在浏览器内运行">
            <span>Local Only</span>
          </Tooltip>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <div>
            <span className="app-header__eyebrow">数据分析工具</span>
            <strong>{current?.label ?? 'Nebula SQL'}</strong>
          </div>
          <div className="header-status">
            <span className="header-status__dot" />
            <span>模拟集群运行正常</span>
            <Tag color="blue">数据源 {version.id}</Tag>
          </div>
        </Layout.Header>
        <Layout.Content className="app-content">
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
