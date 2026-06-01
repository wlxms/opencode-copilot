# OpenCode Copilot - Session Target TODO

## High Priority

- [x] **自定义 Agent/模型选择器集成**：切换到 OpenCode Target 后，支持自定义 Agent 和模型选择，显示到 Copilot 对应的 Agent 列表与模型列表中（通过 `ChatSessionProviderOptionGroup` 或 `registerLanguageModelChatProvider`）

- [x] **还原会话历史**：`provideChatSessionContent` 返回真实的会话历史（从 OpenCode backend 获取消息并映射为 `ChatRequestTurn` / `ChatResponseTurn`），支持从已注册的 target 恢复之前的对话

## Medium Priority

- [x] **接收图片/附件/会话上下文**：支持从 VSCode 会话中接收图片、文件附件、会话历史等额外信息，传递给 OpenCode backend 处理
