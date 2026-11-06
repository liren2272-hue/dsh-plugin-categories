# dsh-plugin-categories

给「插件」页里**自己安装的插件**自定义分类：分类可以自己命名，每个分类标题带「展开 / 收起」标记，
点一下展开该分类下的全部插件，再点一下只剩分类标题。

## 用法

1. 打开「插件」页，滚到「已安装插件」。平时页面保持原样，除了分组标题右侧多一个 **编辑** 按钮。
2. 点 **编辑**（按钮变成 **完成**）：上方出现分类编辑器，可以新建、改名、↑ ↓ 排序、✕ 删除（误删可撤销）；
   每张插件卡片右侧此时才出现下拉框，选一个分类就把这个插件放进去（选「未分类」可移出）。
3. 点 **完成** 退出编辑模式，编辑器与所有下拉框一并消失，页面恢复干净。
4. 点分类标题展开 / 收起整个分类；标题后面是当前成员数。这一步任何时候都能用，不需要进编辑模式。

分类顺序在编辑器里用 ↑ ↓ 调整，✕ 删除（误删可以点撤销按钮）。

## 收起官方插件组（v1.1.2 新增）

官方的「内置插件」和「实验性插件」两组也可以整体收起：每组标题最左边多了一个折叠箭头，
点一下收起该组全部插件，再点一下展开。两组的状态互相独立，收哪组只动哪组，
和上面「已安装插件」的分类体系互不干扰。这一步任何时候都能用，不需要进编辑模式。

## 数据存放

Host 半把布局存成一份 JSON：

- 有 profile 时：`<DSH_PROFILE_DIR>/data/dsh-plugin-categories/state.json`
- 否则：`<DSH_HOME>/dsh-plugin-categories/state.json`，再退到 `~/.dsh/dsh-plugin-categories/state.json`

Client 半同时留一份 `localStorage` 副本，Host 路由不可用时界面照常可用，并提示。

## 实现说明

宿主「插件」页没有可以包裹或替换列表的 slot，所以 Client 半用 DOM 手术完成分组：

- 依赖两个稳定钩子：`section[data-plugin-group="bundles"]`（「已安装插件」分组）和
  `li[data-plugin-package]`（每张卡片）。
- 分类标题是插进 `ul` 的 `<li>`，位置由 CSS `order` 决定，不移动 React 自己的节点（收起时只是
  `display: none`），因此 React 重渲染不会把状态弄乱。
- 注入的控件一律 `position: relative; z-index: 2`，才能盖住宿主卡片上 `inset: 0` 的点击热区。
- 数据通道是 Host 的 `webServer` prefix 路由 `/dsh-plugin-categories/state`（GET/POST）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：读写 JSON、暴露 `/dsh-plugin-categories/state` |
| `client.js` | Client 半：分组渲染、编辑模式与分类编辑器、卡片下拉框 |
| `cordis.patch.yml` | bundle 补丁 |
| `locale/{zh,en}.json` | 插件页显示的名称与描述 |
