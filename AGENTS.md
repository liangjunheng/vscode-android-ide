# 项目编码规则

## 强制规则入口

- 每轮开始必须加载并遵守 `.agents/skills/project-workflow/SKILL.md`;它是本项目通用工作流门禁和验证追踪的唯一正文。
- 当前上下文已确认该 skill 完整且为最新版本时可复用;缺失、变更或版本不明时必须重新加载,未通过不得开始任务。

## 项目专属规则

- 本项目为 Device Tools for Android 的 VS Code 扩展,项目专属约束统一在根 `AGENTS.md` 中维护;`CLAUDE.md` 仅引用本文件,不得重复维护规则正文。
- 不得从其他项目自动植入 Rust unsafe 边界、SDK/NDK 构建路径等不适用于本项目的约束。
- 测试、类型检查和构建使用本项目 `package.json` 中声明的命令;Node.js 版本须满足其 `engines.node` 要求。
