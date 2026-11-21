# 项目编码规则

### Android SDK/NDK 路径

- 构建、测试或验证(含脚本和临时命令)使用 Android SDK/NDK 前,读取根 `local.properties`:SDK 用 `sdk.dir`,NDK 优先用 `ndk.dir`,否则按项目声明版本在该 SDK 的 `ndk/` 下定位;测试/验证 NDK 必须与该声明版本一致,并以其 `source.properties` 的 `Pkg.Revision` 核验。按 Java Properties 解析转义,不得硬编码或猜测路径;配置缺失、版本不明、版本不一致或目录不存在时报告阻塞,不得改用其他版本。

### Rust unsafe 边界

- gfx 的 unsafe 只能在 `lib-core-gfx/src/vulkan/core/`;whiteboard 只能在 `lib-core-whiteboard/src/export/jni/`;render 全部禁止 unsafe。
- gfx/whiteboard crate 根分别保持 `#![deny(unsafe_code)]`,仅 `vulkan.rs` 的 `mod core;`、`export/mod.rs` 的 `mod jni;` 允许例外;render 保持 `#![forbid(unsafe_code)]`。约束覆盖 unsafe 块、函数、trait、impl、extern、不安全属性及所有平台、条件编译、测试、示例和宏展开。
- 不得通过 `#[path]`、`include!`、宏、重导出、降低 lint 或 `allow/expect(unsafe_code)` 绕过边界。
- gfx 的裸 Vulkan/Ash、资源生命周期、裸指针、命令录制和不安全 ABI 必须由 core 持有;whiteboard 的 JNI、Android 原生窗口和句柄生命周期必须由 `export/jni/` 持有;render 只能调用安全 gfx 接口。
- 不得删除仍有安全前置条件的 `unsafe fn`;新增 unsafe 必须有 `SAFETY`,不安全公开入口必须有 `# Safety`。未经明确要求不得改变公开签名、C/JNI 符号、命令顺序或资源生命周期。
