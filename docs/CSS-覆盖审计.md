# CSS 覆盖审计

审计日期：2026-09-06。

## 当前基线

- 文件：`public/styles.css`
- 体积：180,206 bytes，819 行（大量规则压缩在同一行）
- `!important`：741 处
- `:root`：3 组
- `main`：6 组
- 浏览器首屏基线：BTC/USDT 页面可正常渲染，控制台无错误。

### 桌面端计算样式基线

以下值直接从浏览器 `getComputedStyle` 读取，用于迁移后的等价判断：

| 节点 | 关键计算值 |
| --- | --- |
| `main` | width `1304px`，max-width `1360px`，padding `20px 0 38px` |
| `main > header` | flex，padding `12px 14px`，radius `19px` |
| `.terminal-layout` | grid，columns 约 `761px / 525px`，gap `18px` |
| `.chart-box` | height `440px`，position `relative`，overflow `visible` |
| `#signal` | `40px` SF Mono，颜色 `rgb(255, 77, 106)` |
| `#indicators` | 两列 grid，gap `8px 16px` |

### 手机端计算样式基线

在 Chrome Inspect 的设备模拟 `430 × 932`、DPR `3` 下读取：

| 节点 | 关键计算值 |
| --- | --- |
| `main` | width `430px`，padding `14px 12px 28px` |
| `.terminal-layout` | 单列 grid，gap `18px` |
| `.side-stack` | 单列 grid，gap `16px` |
| `.chart-box` | height `315px`，overflow `visible` |
| `#indicators` | 单列 grid，gap `8px 16px` |

### 平板端计算样式基线

在 Chrome Inspect 的 iPad Pro 模拟 `1024 × 1366`、DPR `2` 下读取：

| 节点 | 关键计算值 |
| --- | --- |
| `main` | width `976px`，padding `20px 0 38px` |
| `main > header` | grid，padding `12px 14px`，radius `19px` |
| `.terminal-layout` | 单列 grid，gap `18px` |
| `.side-stack` | 单列 grid，gap `16px` |
| `.chart-box` | height `440px`，overflow `visible` |
| `#indicators` | 两列 grid，gap `8px 16px` |

## 覆盖类型

| 类型 | 例子 | 处理方式 |
| --- | --- | --- |
| 末尾同选择器覆盖 | `main`、`header h1`、`.zoom-tools` | 合并为最终计算值，保留媒体查询差异。 |
| 局部布局强制覆盖 | `.trade-confirmation-row`、`.compact-indicator` | 先在对应组件模块中保留最终网格值，再去掉低优先级重复声明。 |
| 交互层级强制覆盖 | 下拉菜单、图表提示、帮助气泡 | 保留必要的 `z-index` 与溢出规则，不能仅按出现次数删除。 |
| 响应式覆盖 | 移动端 `main`、控制区、指标网格 | 迁移时独立放进媒体查询模块。 |
| 已无运行时用途的历史规则 | 与已删除 DOM / 旧渲染器绑定的选择器 | 先通过 DOM 查询和截图确认后才删除。 |

## 等价重写顺序

1. 建立 CSS 层次：token、base、layout、components、utilities、responsive。
2. 先迁移 `:root`、`body`、`main`、`header` 与图表容器，逐项以当前最终计算样式为准。
3. 迁移决策卡、指标卡、预测卡与风险工具。
4. 迁移响应式规则。
5. 每轮以同一窗口截图、控制台和 DOM 关键节点比对；只有视觉等价时才删除原规则。

## 禁止事项

- 不以减少 `!important` 数量为唯一目标。
- 不改动卡片文字、DOM 顺序、折叠状态或响应式断点行为。
- 不删除含有 `z-index`、`overflow`、`position` 或媒体查询的规则，除非已完成等价截图验证。
