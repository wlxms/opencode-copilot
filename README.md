# ACPilot

在 VSCode Copilot Chat 中使用任意 [ACP (Agent Client Protocol)](https://github.com/zcovex/acp) 兼容的 AI 编码助手后端。

`@opencode hello` → 实时推理过程 → 工具调用 → AI 流式输出

ACPilot 以 ACP 协议为语义核心,将后端与 VS Code surface 解耦。当前内置 OpenCode backend,后续将拓展支持所有 ACP 协议兼容的 backend。

## 功能

- **聊天集成**: 在 Copilot Chat 输入 `@opencode` 即可对话
- **实时推理显示**: AI 思考过程实时流式展示（thinkingProgress API）
- **原生工具调用卡片**: 文件读取、Shell 命令等以原生 UI 渲染，可点击展开
- **子代理支持**: 子代理/子任务自动以可展开卡片展示
- **流式输出**: AI 回复 token-by-token 实时显示
- **斜杠命令**: `/new` 新会话, `/help` 帮助, `/model` 模型列表
- **ACP-first 架构**: 以 ACP 语义层解耦 backend 与 VS Code surface,OpenCode 是当前内置 backend,架构上可扩展到任意 ACP 协议 backend
- **实验性 Session Provider 开关**: 可在入口层按运行时能力切换是否启用实验性 surface

## 工具调用 UI 展示

```typescript
read / list / grep   → 可折叠的 Input/Output 区块
bash / shell         → 终端样式 + 执行耗时
write / edit         → 文件引用列表（可点击跳转）
task / subagent      → 点击展开子代理完整对话
```

## 安装

1. 确保已安装 [OpenCode CLI](https://opencode-ai.com) 并完成认证
2. 克隆仓库
   ```bash
   git clone https://github.com/wlxms/acpilot.git
   cd acpilot
   npm install
   ```
3. 构建
   ```bash
   npm run compile
   ```
4. 在 VSCode 中按 `F5` 启动扩展开发主机

## 使用

在 Copilot Chat 中输入：

| 输入 | 效果 |
|------|------|
| `@opencode read package.json` | 调用 read 工具读取文件，展示 AI 回复 |
| `@opencode /model` | 显示可用 AI 模型列表 |
| `@opencode /new` | 开始新对话会话 |
| `@opencode /help` | 显示帮助 |

## 开发

```bash
# 类型检查
npm run lint

# 测试（350+ 单元测试）
npm test
```

### 技术栈

| 层 | 技术 |
|---|------|
| 聊天 UI | VSCode Chat Participant API (稳定 + `chatParticipantAdditions` proposal) |
| 流式桥接 | SSE 事件 → `thinkingProgress()` / `markdown()` |
| 工具渲染 | `ChatToolInvocationPart` + 6 种 `toolSpecificData` |
| SDK | `@opencode-ai/sdk` ^1.16.0 |
| 构建 | esbuild (ESM→CJS) |
| 测试 | vitest + 自定义 vscode mock |

### ACP-first 架构

当前代码库采用 **SSP-first / SSS-owned-stream** 分层架构，彻底解耦协议语义、序列化与平台渲染：

```txt
src/
├── acp/                  # ACP 协议语义层（零 vscode / SDK 依赖）
│   ├── backend.ts        #   AcpBackend / AcpBridge 核心接口
│   ├── streaming/        #   可序列化会话流（SSS：拥有 vscode 流，push/update API）
│   ├── serializable/     #   JSONL 序列化（session.jsonl / meta.jsonl）
│   └── checkpoint/       #   Checkpoint 审批状态与持久化
├── ssp/                  # 可序列化流部件层（SSP 自洽：状态 + 渲染 + 序列化）
│   ├── types.ts          #   SerializableStreamPart 基类 + IMutableStreamPart
│   └── impl/             #   10+ 具体 SSP（AssistantText / Reasoning / Tool / Edit / Question …）
├── backends/opencode/    # OpenCode → ACP 后端适配（Bridge 薄路由 ~825 行）
├── acpmodels/            # Copilot ⇄ ACP 模型双向同步注册表
├── surfaces/vscode/      # VS Code surface（稳定 participant + 实验 session provider）
├── participant/          # ChatRequestHandler 编排层（handler + checkpoint + title）
├── settings/             # Webview 设置面板
├── opencode/             # SDK 封装（server + client）
└── extension.ts          # 入口：backend + surface 装配
```

**数据流**：

```
用户消息 → ChatRequestHandler → SessionManager 解析会话
  → SerializableSessionStream 创建本回合流
  → OpenCodeBackend.sessions.prompt → 后端 SSE 事件
  → OpenCodeBridge.run() 路由事件
  → SSS.push(SSP) / update(id, data)
  → SSP 渲染到 ChatResponseStream + 追加到 session.jsonl
```

- `src/acp/*`：定义统一语义事件、会话、权限、模型接口，后端可替换
- `src/ssp/*`：每个 SSP 自洽——拥有自身状态、渲染逻辑、序列化契约，直接 import vscode 类型
- `src/acp/streaming/*`：`SerializableSessionStream` 拥有 vscode 流，Bridge 只调 `push()/update()`，永不直接触达 UI
- `src/backends/opencode/*`：`OpenCodeBridge` 是 ~825 行薄路由，将 ACP 事件映射到 SSP 调用

3 文件持久化（中断安全）：

```
{workspaceRoot}/.acpilot/{backend}/{sessionId}/
├── meta.jsonl                  # 会话元数据（快速索引）
├── session.jsonl               # 流部件（append-only）
└── subsessions/{subId}/        # 子代理独立文件（递归嵌套）
    └── subsession.jsonl
```

### 实验性 Session Provider

默认仍然使用稳定的 chat participant 路径。

如果想实验性启用 session provider surface，可在 VS Code 设置中打开：

```json
{
  "acpilot.experimental.sessionProvider": true
}
```

说明：

- 该开关**只在运行时存在对应 proposed API 时生效**
- 如果运行环境不支持，扩展会自动回退到稳定 participant 路径
- 当前实验 surface 主要用于架构隔离和未来扩展点预留

### 项目结构

```
src/
├── extension.ts              # 入口: activate/deactivate，注册 ChatParticipant
├── statusbar.ts              # 状态栏管理
├── acp/                      # ACP 协议语义层
│   ├── backend.ts            #   AcpBackend / AcpBridge 核心接口
│   ├── streaming/            #   SSS 会话流（push/update，3 文件持久化）
│   ├── serializable/         #   JSONL 序列化器
│   ├── checkpoint/           #   Checkpoint 状态存储
│   └── ...                   #   事件总线 / 会话映射 / 选择存储
├── ssp/                      # 可序列化流部件层（自洽状态 + 渲染）
│   ├── types.ts              #   SerializableStreamPart 基类
│   └── impl/                 #   10+ 具体 SSP（Text/Reasoning/Tool/Edit/…）
├── backends/opencode/        # OpenCode 后端（Bridge 薄路由 + 事件归一化）
├── acpmodels/                # Copilot ⇄ ACP 模型双向同步
├── surfaces/vscode/          # VS Code surfaces（稳定 + 实验 + 能力检测）
├── participant/              # ChatRequestHandler 编排（handler/commands/checkpoint）
├── settings/                 # Webview 设置面板
├── opencode/                 # SDK 封装（server + client）
├── types/                    # 共享类型（ExtensionState + vscode proposed API 声明）
└── test/                     # vitest 测试（350+ 用例）
```

详细技术文档见 [doc/tech-summary.md](doc/tech-summary.md)。

## 许可证

MIT
