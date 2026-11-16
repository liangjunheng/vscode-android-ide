# Android Run Panel

The compact Device Tools panel selects a Gradle root, Android module/variant,
and device above the existing mirror.

## Prerequisites

Open a trusted Android workspace with its Gradle Wrapper, JDK and Android SDK.
Refresh executes the real Wrapper tasks listing and may download dependencies.
Install, Run and Debug require an online USB-debugging-authorized device.
Physical-device mirroring remains available without a Gradle project.

## Actions

Build runs the selected assemble task. Install runs its matching install task,
with ANDROID_SERIAL set to the selected device. Run installs before launching
the package identified by that module's APK output metadata. Stop cancels the
active operation or stops the app started by this panel on its original device.
Output opens the Android Build channel. The panel retains bounded output.

## Debug

Install a compatible Android debug adapter and configure it in the workspace
launch configuration. Debug asks which configuration to use and supplies serial
and packageName. Device Tools is not a debug adapter and does not automatically
configure JDWP forwarding or adapter-specific source mappings. Configure those
according to the adapter documentation. Missing configurations or adapter
startup failures are reported, not treated as successful debugging.

## Scope And Validation

Application modules use standard Gradle module directories and AGP APK
output-metadata.json. Custom projectDir/buildDir layouts require matching output
metadata support. The panel does not install a JDK, SDK, system image or adapter.

Run npm test, npm run typecheck and npm run compile for regression verification.
Browser fixtures validate compact controls separately from VS Code. A real
Android build/install/debug session still requires a configured Android project.
