# @billqiu1126/dsh-workspace-hierarchy

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 插件：把侧边栏工作区列表变成**多级（主 / 子工作区）树**。

> [English version: README.md](./README.md)

## 功能

- 工作区按**目录路径包含关系**自动分层：目录位于另一个工作区目录内的，就缩进显示在它下面（支持任意层级）。
- 只有**真正被添加为工作区**的目录才显示；`build`、`docs` 这类普通子文件夹不会被列出来。
- 每个工作区的 **`+` 按钮变成菜单**，二选一：
  - **新建会话** —— 在该工作区新建会话（原有行为）；
  - **添加子工作区** —— 选择目录并注册为子工作区（只添加、不自动新建会话）。
- 每个会话的 **`⋯` 菜单新增「删除会话」** —— 永久删除该会话及其日志（有确认对话框，不可撤销）。
- 每个会话的 **`⋯` 菜单新增「移动会话」** —— 选择目标目录并确认后，重写该会话的 `cwd` 并重新挂到目标工作区（移动后请重启 `dsh web`）。
- 工作区的 **`⋯` 菜单「重命名」现在会同步重命名磁盘文件夹**，并把该文件夹下的会话与子工作区一并迁移（完成后请重启 `dsh web`）。
- 工作区的 **`⋯` 菜单「删除」现在会同步删除磁盘文件夹及其全部内容**，并移除该工作区（含其下的子工作区）注册；会话日志保留，其会话回到「未分组」。
- 折叠主工作区时，其下的**子工作区也会一起折叠**（不再只折叠会话）。

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

「删除会话」横跨两半实现：**宿主侧**注册 `delete-session` 斜杠命令，删除会话的持久化日志并把它从所有工作区的会话账目中移除（DSH 没有「删除会话」RPC，只有归档）；**浏览器侧**在 `⋯` 菜单里加「删除会话」项来触发该命令。

「删除 / 重命名工作区」同样由宿主侧命令完成：`delete-workspace` 删除磁盘文件夹并移除工作区注册，`rename-workspace` 调用 `tools/rename-workspace.js` 重命名磁盘文件夹并重写其下所有会话的 `cwd`。

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
    ├── index.js      # 宿主侧：注册 delete-session / move-session / delete-workspace / rename-workspace 命令
    └── client.js     # 浏览器侧（预打包 client bundle）
└── tools/
    ├── move-session.js     # 移动会话的迁移脚本
    ├── rename-workspace.js # 重命名工作区目录并迁移会话的脚本
    └── package.json        # 让 tools/*.js 以 CommonJS 运行
```

## 说明

- 宿主侧提供 `delete-session` / `move-session` / `delete-workspace` / `rename-workspace` 命令，浏览器侧提供对应菜单；`dsh.client` 声明了 `platform: "web"` 和注入顺序。
- 工作区层级是**只读推导**：不改动工作区数据。
- 路径比较在 Windows 上忽略大小写；`/` 与 `\` 均被识别为分隔符。
- 「未分组」不是真实工作区，而是**收容不属于任何工作区的会话**的虚拟桶：它不能重命名/删除（没有对应文件夹），但它下面的会话仍可单独重命名、移动、归档、删除。

## 删除会话 — 已知限制

- DSH 没有「永久删除会话」RPC（只有归档），所以宿主侧直接删除 JSONL 后端的会话日志文件（`sessionPersistence.list()`/`locate()` 后 `rm`）。
- 仍在当前进程里打开（存活）的会话：日志被删除后如果继续产生事件，日志可能被重新写入；关闭 / 重启 DSH 才能最终确定对存活会话的删除。
- 删除通过运行 `delete-session` 命令触发，浏览器侧通过 `commands.execute` 传入会话 id。

## 移动会话（菜单 + 迁移工具）

移动会话有两种入口：会话 `⋯` 菜单里的 **「移动会话」**（宿主 `move-session` 命令 + 目录选择 + 确认），以及随包的低层级脚本 `tools/move-session.js`（真正执行重写）。DSH 没有「移动会话」功能（会话的 `cwd` 不可变），所以命令会调用这个脚本重写会话日志的 `cwd` 头并重新挂到目标工作区。

```bash
# 列出某工作区下的会话（找到准确的「名称」）
node tools/move-session.js --list "<工作区路径>"

# dry-run（只校验、不落盘）
node tools/move-session.js "<会话路径>" "<会话名称>" "<目标工作区路径>"

# 真正移动
node tools/move-session.js "<会话路径>" "<会话名称>" "<目标工作区路径>" --apply
```

需要时可用环境变量覆盖存储位置：

- `DSH_SESSION_ROOT`（默认 `~/.dsh/sessions`）
- `DSH_STORAGE_DIR`（默认 `~/.dsh/storages`）
- `DSH_MIGRATE_BACKUP_DIR`（备份位置）

脚本会校验一切、先写备份，只有加 `--apply` 才真正改动；执行后重启 `dsh web`。

## 删除 / 重命名工作区（含磁盘文件夹）

- **删除工作区** = 删除磁盘文件夹（`rm -r`）+ 移除该工作区及其下所有子工作区的注册。会话日志存在 DSH 数据目录下（不在工作区文件夹内），因此会被保留，其会话回到「未分组」。
- **重命名工作区** = 把磁盘文件夹改名为新名称（`父目录/新名称`），并重写其下所有会话的 `cwd`（日志头 + 日志位置 + projcache）以及所有子工作区的 `path`；名称会在侧边栏立即更新，重启 `dsh web` 后同步会话数据。
- **重命名工作区** 会先**关闭该文件夹下空闲（未运行）的存活会话**（flush + 卸载，其日志随后被安全重写，重启后在新位置恢复）；只有**正在运行**的会话才拒绝执行。删除工作区**不会**拦截存活会话（删除不碰日志，只是让该会话的 `cwd` 失效）。
- 删除会拒绝文件系统根目录、用户主目录，以及包含 DSH 数据目录（`DSH_HOME`）的文件夹。
- 重命名脚本 `tools/rename-workspace.js` 同样支持 dry-run / `--apply`，并先写备份；日志缺失的会话会被跳过（仅更新 projcache），不会中断整个重命名。

```bash
# dry-run
node tools/rename-workspace.js --id "<工作区-id>" "<新名称>"

# 真正执行
node tools/rename-workspace.js --id "<工作区-id>" "<新名称>" --apply
```
