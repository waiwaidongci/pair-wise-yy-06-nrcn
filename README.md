# Nebula SQL 查询工作台

基于 React、TypeScript、Vite、Ant Design、Monaco Editor、Zustand、TanStack Query
和 React Router 构建的浏览器 SQL 工作台。执行引擎完全运行在前端内存中，不依赖后端。

## 功能

- 数据库 / 表 / 字段结构树与模糊检索
- 多标签 SQL 编辑器、语法高亮、自动补全、格式化与错误行标记
- `Ctrl/Cmd + Enter` 执行，长查询可取消，多标签批次可并发
- 自研简单 `SELECT / WHERE / ORDER BY / LIMIT` 解析与过滤
- 虚拟滚动结果表、列宽调整、双击复制、CSV 导出和分页
- 查询历史、收藏语句、错误信息中文映射
- 使用 localStorage 持久化标签页、历史和收藏

## 执行批次与数据源版本

每次「执行」都会创建一个**执行批次（Batch）**，将标签、结果快照、历史记录串联为可追溯链：

- **提交即固定**：批次创建时固定查询语句与数据源版本（如 `v2-68c025`），之后数据源刷新不影响该批次的依据
- **同一标签只接受最新批次**：后发批次会立即取代在飞的旧批次；取消、失败或晚到的旧批次结果由三层守卫拒绝写回，不会覆盖当前结果
- **版本刷新**：侧栏「刷新数据」模拟 ETL 产出新版本，在飞批次立即中止并标记「已失效」；已完成的旧版本快照保留在结果区（黄色横幅）并自动按新版本重算
- **历史保留依据**：历史页每条记录展示批次号、固定的数据源版本、状态与结果；「同批次重试」沿用原批次号做幂等更新，不追加重复记录
- **旧数据回填**：缺少批次号 / 版本的历史记录在恢复时先回填（标记 `legacy-unpinned` 与「旧记录已回填」）再参与恢复
- **写失败回滚**：持久化写入失败时恢复到上一次完整批次（历史页可点「模拟写入失败」验证），重试不产生重复记录

页面重新加载后，未完成的在飞批次按「已取消」收敛并自动重算。

## 运行

```bash
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```

支持示例：

```sql
SELECT order_no, customer_name, amount, status
FROM orders
WHERE amount > 5000 AND status = '已完成'
ORDER BY amount DESC
LIMIT 200;
```
