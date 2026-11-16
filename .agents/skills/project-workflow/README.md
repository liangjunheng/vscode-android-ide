# project-workflow 通用可移植包

复制整个文件夹到目标项目 `.agents/skills/project-workflow/`,然后调用 `project-workflow` skill 即可。用户不需要手动运行安装命令;Agent按SKILL内的自动初始化协议检测环境、运行内置bootstrap并核对原生回执。

## 包内容

- `SKILL.md`:通用规则、自动初始化和9项工作流。
- `REVIEWER.md`:语言和IDE无关的独立审查协议。
- `harness/bootstrap.mjs`:Agent自动检测项目/profile,无项目规则时生成通用入口,保留所有已有规则。
- `harness/install.mjs`:备份并幂等注册本机插件,只维护自己的标记项,不覆盖其他配置;源码revision防止使用旧缓存。
- `harness/guard.mjs`:按当前项目读取全部存在的根规则和包内正文,校验结构/哈希并提供原生回执;不绑定Rust、框架或固定规则指纹。
- `test/`:复制到新路径、非Rust空项目、已有不同根规则、自动初始化、幂等、安全失败、会话/哈希/异常传播回归测试。

## Agent内部执行

已有Node.js 22+或宿主提供的兼容运行时即可,脚本只用内置模块,无需npm安装。Agent用本skill的资源目录定位 `harness/bootstrap.mjs`,在目标项目运行;有 `DSH_PROFILE_DIR` 时自动使用,否则仅在检测到受支持的Harness profile后由Agent传参。不要让用户自己填写或执行命令。缺运行时/权限时报告阻塞并申请授权,不偷偷全局安装。

目标项目可以只有AGENTS、只有CLAUDE或两者各自有不同规则,均按来源完整读取,不要求相同。均不存在时bootstrap创建最小AGENTS入口。项目特定安全约束始终由目标项目规则管理,不从源项目植入,也不由通用结构校验冒充语义审计。

## 验证与边界

Agent验证命令: `node --test .agents/skills/project-workflow/test/*.test.mjs`。guard函数映射guard.test;install映射install.test;bootstrap/findProjectRoot映射bootstrap.test。当前Harness原生接口已验证,其他客户端只有在支持skill及相应宿主插件机制时才能自动配置;不支持时明确阻塞,不能宣称任意IDE仅复制即自动执行。

profile本机URL由当前位置生成,不复制旧机器URL;移动后Agent自动重跑bootstrap。所有源码/说明使用相对路径。配置成功不是加载凭证,只接受当前HOST_WORKFLOW_RECEIPT。回执证明当前结构读取和原文提供,不证明AI遵从或业务正确;没有独立GUI徽标,仍有编辑到发送竞态,不抵御恶意管理员/插件。
