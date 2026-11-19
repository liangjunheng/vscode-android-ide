# Architecture

```
src/
  extension.ts        activation, command registration
  sdk.ts              SDK discovery, adb/emulator/avdmanager helpers, AVD config files,
                      emulator gRPC port and token lookup (avd/running/*.ini)
  deviceManager.ts    AVD commands (create/start/stop/edit/wipe/delete, add device, pairing)
  deviceManagerView.ts  Device Manager webview provider (polls adb every 3 s)
  runningDevices.ts   Running Devices view: device selection, native scrcpy lifecycle, embedded frame pipeline, input, toolbar, skin, screenshot, recording
  emulatorGrpc.ts     Emulator gRPC client (screen stream, touch, keys, native Extended Controls)
  scrcpy.ts           Native scrcpy process and embedded scrcpy server session
  skin.ts             Parses emulator skin "layout" files (device frame)
  extendedControls.ts Native Extended Controls with a webview fallback
  logcat.ts           Logcat panel provider (adb logcat stream, package/pid mapping)
media/
  logcat/             Logcat UI (main.js) and filter language (filter.js, unit-tested)
  devicemanager/      Device Manager UI
  extended/           Extended Controls fallback UI
  icons/ codicons/    Assets (see NOTICE)
resources/            Bundled scrcpy server (see resources/README.md)
```

## Running Devices modes

1. **Embedded modes** (default): emulator gRPC, embedded scrcpy H.264/WebCodecs, then screenshot fallback.
2. **Native scrcpy** (`android-ide.nativeMirror: true`): starts the external scrcpy client as an independent process, so decoding and rendering do not use the VS Code Webview/UI thread. Configure `.vscode/android-ide.local.json` `scrcpyPath` when scrcpy is not on PATH.
3. **Screenshot loop**: `adb exec-out screencap`.

On failure the provider falls back to the next mode.

## Webview/extension messages

Webviews talk to the extension through `postMessage`; message handlers are the `onMessage` switches in each provider. Frames use an ack so that only one frame is in flight.

## Device skins

Read from the AVD's `skin.path` (or `<sdk>/skins/<skin.name>`). Only the portrait layout is rendered; the frame is hidden in landscape.
