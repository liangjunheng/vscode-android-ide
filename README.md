# VSCode Android IDE

VSCode Android IDE brings Android development tools into VS Code. Manage emulators and physical devices, mirror screens, browse files and processes, stream Logcat, and access debugger configuration entries without leaving the editor. The built-in debugger backend is temporarily unimplemented.

## Features

### Devices and emulators

- Discover Android emulators and connected devices through the Android SDK and adb.
- Create, edit, start, cold boot, stop, wipe, and delete AVDs.
- Pair physical devices over Wi-Fi.
- Show device state, model, API level, transport type, authorization state, and errors.
- Synchronize device selection across the picker, mirror, Explorer, Processes, and Logcat.

### Running Devices

- Mirror emulator screens through emulator gRPC.
- Mirror physical devices through scrcpy with screenshot fallback.
- Send touch, swipe, keyboard, back, home, overview, power, volume, rotation, screenshot, and recording actions.
- Open emulator Extended Controls when supported.
- Switch between Mirror, Files, Processes, and Hidden modes.

### Device Explorer and Processes

- Browse remote Android file systems and transfer files or directories.
- Create, rename, remove, download, upload, and open remote entries.
- Preserve empty directories during recursive transfers.
- Track debuggable processes through JDWP and show PID, package, VM, ABI, user ID, and debugger state.
- Retain the debugger selection entry; built-in debugging is currently a placeholder. Stop processes, force-stop applications, clear app data, and uninstall packages.

### Logcat

- Stream Logcat from the selected device.
- Search and filter by tag, package, process, message, line, level, age, crash, and stack trace.
- Support exact, regex, negated, grouped, and combined filter expressions.
- Use autocomplete, history, favorites, match-case, whole-word, and regex options.
- Pause, restart, soft-wrap, navigate stack traces, take screenshots, and record the device screen.
- Keep active and paused buffers bounded by a configurable UTF-8 byte limit.

### Debugging

- Keep the built-in Android debugger interface and Java/Kotlin registration available for future implementation.
- Built-in Kotlin/Java, Native, and JVM+Native choices currently display an explicit not-implemented notice and do not start a debug backend.
- Existing external launch configurations continue to use their VS Code debug adapters.

## Requirements

- VS Code 1.95 or later.
- Node.js 22 or later for development and packaging.
- Android SDK with platform-tools, emulator, and command-line tools.
- An installed Android system image for emulator workflows.
- A physical device with USB debugging for device workflows.
- LLDB and NDK tools for native debugging features.

The extension discovers the Android SDK from project-local configuration first, then ANDROID_HOME, ANDROID_SDK_ROOT, and standard installation locations. The scrcpy server is bundled.

## Configuration

Settings, commands, and view IDs use the android-ide.* namespace exclusively. The previous android.* namespace is not supported.

| Setting | Default | Purpose |
|---|---:|---|
| android-ide.embeddedEmulator | true | Start emulators without their own window and show them in Running Devices. |
| android-ide.mirrorVisible | true | Enable the device mirror surface. |
| android-ide.deviceViewMode | mirror | Select mirror, explorer, processes, or hidden. |
| android-ide.explorer.packageFilter | false | Filter Explorer packages and processes by project application IDs. |
| android-ide.mirrorIntervalMs | 150 | Screenshot fallback interval in milliseconds. |
| android-ide.logcat.maxBytes | 1048576 | Logcat UTF-8 buffer limit from 65536 to 67108864 bytes. |
| android-ide.fixSoftwareRendering | true | Enable host GPU settings for AVDs created with software rendering. |

## Project-local configuration

Machine-specific paths belong in .vscode/android-ide.local.json at the project root. The extension validates this file with its bundled schema. The file is ignored by source control and is not synchronized by VS Code Settings Sync.

Example configuration fields: sdkPath, downloadDirectory, debugger.adbPath, debugger.lldbDapPath, and debugger.ndkPath. Relative paths resolve from the project root. Empty or missing values use automatic discovery and defaults.

## Commands

All extension commands use the android-ide.* prefix. Common commands include android-ide.refresh, android-ide.addDevice, android-ide.startAvd, android-ide.stopAvd, android-ide.createAvd, android-ide.deleteAvd, android-ide.mirrorDevice, android-ide.showLogcat, and android-ide.extendedControls.

## Development

```bash
npm ci
npm run compile
npm run typecheck
npm test
```

- npm run compile: bundle the extension with esbuild.
- npm run watch: rebuild on source changes.
- npm run typecheck: run strict TypeScript checking.
- npm test: run the Node.js test suite.
- npm run package: build the VSIX package.
- npm run vscode:prepublish: typecheck, build production bundles, and verify runtime content.

Press F5 in VS Code to launch an Extension Development Host. Reload the host after rebuilding when the extension bundle changes.

## Safety and privacy

- adb, emulator, SDK, and debugger tools run locally.
- Explorer operations are scoped to the selected device and reject unsafe paths.
- File transfers validate local and remote paths before writing.
- No telemetry is sent. Network traffic is limited to local Android tooling and connected devices.
- Do not commit project-local SDK paths, device logs, screenshots, or generated test artifacts.

## Troubleshooting

- If no devices appear, verify the Android SDK, adb authorization, and the project-local SDK path or environment variables.
- If an emulator is slow, enable android-ide.fixSoftwareRendering or set the AVD GPU mode to auto.
- If physical-device video is unavailable, authorize USB debugging and verify scrcpy support.
- If a debugger cannot start, verify project-local adb, LLDB, NDK, and runtime tool paths.
- If a setting appears ineffective, confirm that its key starts with android-ide. and reload the Extension Development Host.

## Architecture

The TypeScript backend is under src/. Webview clients are under media/. Device communication is isolated behind SDK, adb, emulator gRPC, scrcpy, JDWP, and file-transfer modules. See docs/ARCHITECTURE.md for module boundaries and lifecycle details.

## License

MIT. Third-party licenses and notices are documented in NOTICE and THIRD_PARTY_NOTICES.md.
