# @billqiu1126/dsh-workspace-hierarchy

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 插件：把侧边栏工作区列表变成**多级（主 / 子工作区）树**。

> [English version: README.md](./README.md)

## 功能

- 工作区按**目录路径包含关系**自动分层：目录位于另一个工作区目录内的，就缩进显示在它下面（支持任意层级）。
- 只有**真正被添加为工作区**的目录才显示；`build`、`docs` 这类普通子文件夹不会被列出来。
- 每个工作区的 **`+` 按钮变成菜单**，二选一：
  - **新建会话** —— 在该工作区新建会话（原有行为）；
  - **添加子工作区** —— 选择目录并注册为子工作区（只添加、不自动新建会话）。

示例：

```
▼ DeepSeek-Harness                    主工作区
    ▼ DeepSeek Harness Desktop        子工作区
        [会话…]
    ▼ Test Deep SeekHarness           子工作区
        [会话…]
    [DeepSeek-Harness 自己的会话…]
```

## 原理

本包是内置工作区浏览器（`@deepseek-ai/dsh-client-ui-workspace`）的增强构建：在 `deriveGroups` 里按路径推导父子关系、给每个工作区加 `depth` 并按深度缩进，同时把工作区行的 `+` 改成菜单。因为它改的是工作区浏览器的内部渲染，所以需要**替换**内置的 `ui-workspace` 条目。

## 环境要求

- 全局安装 `@deepseek-ai/dsh`（0.1.0-rc.x）。
- 使用 web profile（`dsh web`，或桌面版）。

## 安装

两种方式**二选一**即可：

### 方式 A —— 一键脚本（推荐）

```bash
# Windows（PowerShell）
.\install.ps1

# Linux / macOS
./install.sh
```

脚本会帮你完成「安装包」和「写入 cordis.patch.yml」两步。

### 方式 B —— 手动

**1.** 把包安装到 profile：

```bash
dsh plugin --profile web add @billqiu1126/dsh-workspace-hierarchy
```

**2.** 编辑 `~/.dsh/profiles/web/cordis.patch.yml`（Windows：`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`），加入：

```yaml
# 停用内置工作区浏览器（由本插件替换）。
- id: ui-workspace
  disabled: true

# 挂载多级工作区浏览器。
- insert:
    - id: ui-workspace-hierarchy
      name: '@billqiu1126/dsh-workspace-hierarchy'
```

**3.** 重启 `dsh web`（或桌面版），浏览器刷新页面。

## 发布到 npm

```bash
npm publish --access public
```

## 目录结构

```
@billqiu1126/dsh-workspace-hierarchy/
├── package.json      # dsh.client 声明、peerDependencies、exports
├── install.ps1       # 一键安装（Windows）
├── install.sh        # 一键安装（Linux / macOS）
├── README.md         # 英文文档
├── README.zh.md      # 中文文档
└── lib/
    ├── index.js      # 宿主侧空实现（纯 UI 插件）
    └── client.js     # 浏览器侧（预打包 client bundle）
```

## 说明

- 纯 Web 客户端插件，无宿主侧逻辑；`dsh.client` 声明了 `platform: "web"` 和注入顺序。
- 工作区层级是**只读推导**：不改动工作区数据；删除父工作区后，其子工作区会自动回到顶层。
- 路径比较在 Windows 上忽略大小写；`/` 与 `\` 均被识别为分隔符。
