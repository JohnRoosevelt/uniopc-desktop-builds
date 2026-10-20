---
name: local-document-authoring
displayName: 本地文档
description: "在当前 Uniopc 桌面 Profile 中列出、读取、创建和更新本地文档。项目、项目任务和云端文档已下线。"
---

# 本地文档工作流

使用 `uniopc_local_documents_list` 查询当前 Profile 的本地文档；没有结果时如实说明为空，不要调用已下线的云端项目或任务工具。

读取文档前调用 `uniopc_local_document_get`。用户在本轮 `@` 引用某篇文档，或直接用 `/` 调用本地工作区插件时，均已明确授权当前运行读取该 Profile 的本地文档；不要声称需要到桌面端另行授权。创建和更新时只提交正常 Markdown（标题、段落、列表、表格等）；不要提交 BlockSuite JSON、CRDT 或 Base64 编码。创建和更新属于写操作，必须等待运行时确认；更新前先读取并使用返回的内容哈希，避免覆盖并发修改。

所有文档只保存在当前桌面 Profile。不要声称已同步到云端，也不要要求用户提供项目 ID。
