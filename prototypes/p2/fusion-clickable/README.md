# Miracle P2 融合版可点击原型

> 原型性质：基于 Product Design A/B/C 三张图的 Web 工作台可点击前端原型。

## 视觉与结构来源

- 首页：Product Design A 行动中枢，用于默认首页。
- Run 工作区：Product Design B Run 驾驶舱，用于任务运行页。
- Attention：Product Design C 态势与处置台，重点吸收根因联动和关联对象态势。
- 新任务、Dry-run、审核抽屉：按 Product Design 视觉语言补齐。
- Pencil 六页原型：作为流程、对象语义、状态归属和审核安全校验底稿。

## 最新预览截图

| 页面 | 设计来源 | 截图 |
|---|---|---|
| 首页 | Product Design A | [../../../assets/prototypes/fusion-clickable/home-desktop.png](../../../assets/prototypes/fusion-clickable/home-desktop.png) |
| Run 工作区 | Product Design B | [../../../assets/prototypes/fusion-clickable/run-desktop.png](../../../assets/prototypes/fusion-clickable/run-desktop.png) |
| Attention | Product Design C 根因联动 | [../../../assets/prototypes/fusion-clickable/attention-desktop.png](../../../assets/prototypes/fusion-clickable/attention-desktop.png) |

## 运行方式

```bash
npm install
npm run dev
```

默认地址由 Vite 输出，通常为：

```text
http://127.0.0.1:5173/
```

## 可点击范围

- 左侧导航可切换：首页、新任务、Dry-run、Run 工作区、Attention、审核抽屉。
- 首页的“新任务”“处理”“审核”“打开”可进入对应页面。
- 新任务可进入 Dry-run。
- Dry-run 可启动 Run。
- Run 可切换阶段过滤、选择节点、打开节点详情。
- Run 事件与审计抽屉可展开或折叠。
- Attention 可切换不同根因并刷新关联对象态势。
- 工作流、智能体、资源库、设置保留导航占位，后续单独展开。

## 当前边界

- 当前阶段聚焦 Web 工作台交互。
- 不验证 APP 页面兼容模式。
- 不验证移动端或窄屏响应式布局。
