# dsh-workflow-zcode

[English](#english) | [中文](#中文)

---

## English

A DeepSeek Harness (DSH) plugin that runs **ZCode `.dwf.ts` dynamic workflows**: a TypeScript orchestration script fans work out across named, persistent subagents, executes workspace commands inside the host's sandboxed subprocess service, and records every run in a local SQLite journal. The plugin also ships a ZCode-style sidebar panel for observing and controlling runs.

### What it actually does

- **Compiles and type-checks workflows.** A `.dwf.ts` file (body + optional front matter declaring arguments) is compiled against a virtual facade, type-checked with TypeScript, and lowered into host calls before execution.
- **Persistent named actors.** `agent(name, persona)` creates a named subagent whose session survives later asks, so context accumulates. `await actor.ask<T>(text)` returns schema-validated JSON when `T` is a local interface.
- **Sandboxed execution.** The workflow body runs in a separate child process with a `node:vm` scope. Workspace helpers (`world.run`, `files.*`, `git.*`) are read-oriented and go through the host's subprocess/sandbox services; the plugin does not spawn a shell on its own.
- **Durable journal.** Runs, actors, nodes, artifacts and events are stored in SQLite at `~/.dsh/zcode-workflow/runs.db` (configurable). A failed or cancelled run can be resumed: completed nodes replay from the journal without another model call, and recorded subagent sessions are reattached.
- **Real concurrency control.** `maxConcurrency` caps simultaneous subagent turns (default 13); `maxTotalAgents` caps the lifetime number of subagents (default 200). Both are per run and can be changed from the panel.
- **Pre-execution confirmation gate.** When `confirmExecution` is `'ask'` (default) and the Host exposes `userQuestions`, compiling/resuming a workflow previews phases, actors, commands and source before asking to: allow once, allow all workflows in the current session, decline, or submit revision feedback (persisted per session in SQLite and revocable from the sidebar panel).
- **Optional subagent model.** `subagentModel` follows the calling session by default, or pins a `provider/model`.

### Tools

| Tool | Purpose |
| --- | --- |
| `run_zcode_workflow` | Run a workflow from an inline `script` or a saved `path`. Supports `args`, `name`, `max_total_agents`, `max_concurrency`, `subagent_model` and `dry_run`. |
| `list_zcode_workflows` | List `.dwf.ts` files visible from the session (project `.zcode/workflows` and the global ZCode workflow directory), with their declared arguments. |
| `resume_zcode_workflow` | Resume a failed or cancelled run, reusing completed nodes and recorded subagent sessions. |

### Service contract (for other plugins)

The plugin registers a Cordis service named **`zcodeWorkflow`** (`version` 0.2.3). It is an optional capability, not a dependency for the plugin itself: the sidebar, journal and tools work without any consumer. Other plugins (notably `dsh-mcp-bridge`) discover it with `ctx.get('zcodeWorkflow')` and never import this package.

| Method | Purpose |
| --- | --- |
| `listRuns({ sessionId?, cwd?, status?, limit? })` | Compact run rows (status, phase, node counts, spent tokens), scoped when a session or cwd is given. |
| `getRun({ runId, sessionId, includeScript?, includeTrace?, maxNodes?, maxEvents? })` | One run's phase, bounded nodes, actors (with subagent `sessionId`), artifact metadata, error. Script/trace are opt-in. |
| `progress({ sessionId, limit? })` | Compact active runs for `dsh_wait_session` / `dsh_get_session` summaries. |
| `cancelRun({ runId, sessionId })` | Abort exactly one live run; the parent session is untouched. |
| `resumeRun({ runId, sessionId, allowRehydrate?, maxConcurrency?, subagentModel? })` | Resume a failed/cancelled run (reuses journal nodes and actor sessions). |
| `configureRun({ runId, sessionId, maxConcurrency?, subagentModel? })` | Update plan/caps only. **Never starts a run.** Completed runs are immutable. |
| `deleteRun({ runId, sessionId })` | Remove one settled run and its journal rows. |
| `getSessionPolicy({ sessionId })` / `setSessionPolicy({ sessionId, autoApprove })` | Read/write the workflow auto-execution policy. |

All control methods require the owning `sessionId`; a run whose `parentSessionId` differs answers `WORKFLOW_FORBIDDEN`. Failures carry a stable `WORKFLOW_*` code. The service is unregistered automatically when the plugin fiber unloads.

### Sidebar panel

The plugin registers a right-column **Workflow** tab and a sidebar entry. The panel shows the live run trace: phases and nodes, subagent roster, token usage, artifacts, and run lineage. It supports:

- session / working-directory / all scope filtering (session scope by default);
- `⚙ 配置` to change `maxConcurrency` and the subagent model;
- `↻ 续跑` for failed or cancelled runs;
- `■ 停止运行` for a live run;
- opening a subagent's own transcript (when the host exposes session navigation).

### Requirements

- **Node.js >= 22** (`node:sqlite` is used for the journal).
- DeepSeek Harness **>= 0.2.1-rc.2 < 0.3.0**.
- The host must expose the DSH services the plugin uses: `subprocess`, `agents`, `sandbox`/`sandboxPolicy`, `sessions`, `workingDirectory`, `connection` (for the panel routes) and `slots` (client side).
- No other plugin is required. `zcodeWorkflow` is provided for consumers; `@local/dsh-mcp-bridge` may consume it when both are installed.

### Install

```sh
dsh plugin add dsh-workflow-zcode
```

Then restart DSH so the host bundle and the client module are loaded, and open **Workflow** in the right column.

### Configuration

All keys are optional; the defaults are shown.

```yaml
runToolName: run_zcode_workflow
listToolName: list_zcode_workflows
resumeToolName: resume_zcode_workflow
typeCheck: true
confirmExecution: 'ask'   # 'ask' | 'never'
maxTotalAgents: 200
maxConcurrency: 13
subagentModel: ''          # '' or 'session' follows the calling session
journalFile: ''            # '' -> ~/.dsh/zcode-workflow/runs.db
globalWorkflowDir: ''      # '' -> ~/.zcode/workflows
projectWorkflowDir: ''     # '' -> .zcode/workflows
snapshotDir: ''
```

### Privacy

The plugin writes only to its local journal (and optionally the configured snapshot directory). It contains no telemetry and makes no network requests of its own; model traffic goes through DSH's Agent service.

### Development

```sh
node --test test/*.test.mjs
node scripts/prepare-publish.mjs --name dsh-workflow-zcode \
  --repository https://github.com/google-q-dot/dsh-workflow-zcode --pack
```

### License

MIT © qiaozhao

---

## 中文

这是一个 DeepSeek Harness（DSH）插件，用来运行 **ZCode 的 `.dwf.ts` 动态工作流**：TypeScript 编排脚本把任务分发给具名、可续聊的多个子代理，通过宿主的沙箱子进程服务执行工作区命令，并把每次运行记录到本地 SQLite 运行日志。插件同时提供 ZCode 风格的右侧栏面板，用于观察和控制运行。

### 实际能力

- **编译与类型检查**：`.dwf.ts`（脚本正文 + 可选 front matter 声明参数）会针对虚拟 facade 编译、用 TypeScript 做类型检查，再降级为宿主调用后执行。
- **持久具名 Actor**：`agent(name, persona)` 创建具名子代理，会话会持续保留，后续 `ask` 能继承上下文；`await actor.ask<T>(text)` 在 `T` 为本地 interface 时返回经 JSON Schema 校验的对象。
- **沙箱执行**：工作流正文在独立子进程 + `node:vm` 作用域中运行；`world.run`、`files.*`、`git.*` 等只读/受限能力通过宿主的 subprocess 与 sandbox 服务执行，插件自身不另起 shell。
- **持久运行日志**：run、actor、node、artifact 与事件写入 SQLite（默认 `~/.dsh/zcode-workflow/runs.db`，可配置）。失败或取消的运行可以续跑：已完成的节点直接从日志回放、不再调用模型，记录过的子代理会话会被重新接上。
- **真实并发控制**：`maxConcurrency` 限制同时进行的子代理轮次（默认 13）；`maxTotalAgents` 限制整个 run 创建的代理总数（默认 200）。两者都是 per-run 设置，并可在面板中修改。
- **执行前确认门禁**：默认 `confirmExecution: 'ask'` 且宿主提供 `userQuestions` 服务时，编译/续跑前会先展示阶段、子代理、命令、参数与源码预览，供用户选择「允许这一次」「允许本 Session 自动执行」「拒绝执行」或「填写修改意见退回重写」（会话级自动执行持久化于 SQLite，并可在右侧栏面板一键关闭）。
- **可选子代理模型**：默认跟随发起会话的模型，也可以固定为某个 `provider/model`。

### 工具

| 工具 | 用途 |
| --- | --- |
| `run_zcode_workflow` | 用内联 `script` 或已保存的 `path` 运行工作流；支持 `args`、`name`、`max_total_agents`、`max_concurrency`、`subagent_model` 与 `dry_run`。 |
| `list_zcode_workflows` | 列出当前会话可见的 `.dwf.ts`（项目 `.zcode/workflows` 与全局 ZCode 工作流目录），并返回声明的参数。 |
| `resume_zcode_workflow` | 续跑失败或取消的运行，复用已完成节点与已记录的子代理会话。 |

### 服务契约（供其他插件使用）

插件注册 Cordis 服务 **`zcodeWorkflow`**（`version` 0.2.3）。它是可选能力，本插件不依赖任何消费者；右侧栏、journal 与工具在没有消费者时照常工作。其他插件（如 `dsh-mcp-bridge`）通过 `ctx.get('zcodeWorkflow')` 发现它，不 import 本包。方法包括 `listRuns`、`getRun`、`progress`、`cancelRun`、`resumeRun`、`configureRun`（只改配置、绝不启动运行）、`deleteRun`、`getSessionPolicy`/`setSessionPolicy`。控制类方法必须带所属 `sessionId`；跨会话返回 `WORKFLOW_FORBIDDEN`，失败使用稳定的 `WORKFLOW_*` 错误码。插件卸载时服务自动注销。

### 右侧栏面板

插件会注册右侧栏的 **Workflow** 标签页与侧边栏入口。面板展示实时运行轨迹：阶段与节点、子代理花名册、token 用量、产物以及运行血缘，并支持：

- 「当前会话 / 当前目录 / 全部」作用域筛选（默认锁定当前会话）；
- `⚙ 配置` 修改 `maxConcurrency` 与子代理模型；
- `↻ 续跑` 失败/取消的运行；
- `■ 停止运行` 正在运行的 run；
- 在宿主提供会话导航能力时，打开某个子代理自己的对话记录。

### 环境要求

- **Node.js >= 22**（运行日志使用 `node:sqlite`）。
- DeepSeek Harness **>= 0.2.1-rc.2 < 0.3.0**。
- 宿主需要提供插件使用的服务：`subprocess`、`agents`、`sandbox`/`sandboxPolicy`、`sessions`、`workingDirectory`、`connection`（面板路由）与 `slots`（浏览器端）。

### 安装

```sh
dsh plugin add dsh-workflow-zcode
```

安装后重启 DSH，让宿主 bundle 与客户端模块加载；随后在右侧栏打开 **Workflow**。

### 配置

全部可选，括号内为默认值。

```yaml
runToolName: run_zcode_workflow
listToolName: list_zcode_workflows
resumeToolName: resume_zcode_workflow
typeCheck: true
confirmExecution: 'ask'   # 'ask' | 'never'
maxTotalAgents: 200
maxConcurrency: 13
subagentModel: ''          # '' 或 'session' 表示跟随调用会话
journalFile: ''            # '' -> ~/.dsh/zcode-workflow/runs.db
globalWorkflowDir: ''      # '' -> ~/.zcode/workflows
projectWorkflowDir: ''     # '' -> .zcode/workflows
snapshotDir: ''
```

### 隐私

插件只写入本地运行日志（以及可选的快照目录），没有遥测，也不自行发起网络请求；模型流量通过 DSH 的 Agent 服务。

### 开发

```sh
node --test test/*.test.mjs
node scripts/prepare-publish.mjs --name dsh-workflow-zcode \
  --repository https://github.com/google-q-dot/dsh-workflow-zcode --pack
```

### 许可证

MIT © qiaozhao
