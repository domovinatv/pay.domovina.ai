# Local mobile build setup — Expo / React Native on macOS (no cloud)

**Date:** 2026-06-08 · **Host:** Mac mini M4 Pro, macOS 26.3, arm64 ·
**Stack:** Expo SDK 56.0.9 · RN 0.85.3 · React 19.2.3 · expo-router 56 ·
New Architecture. **Goal:** build & run **web + iOS + Android entirely locally**
(no EAS / no cloud). Context: [ADR 0014](../decisions/0014-mobile-wallet-baseline-and-stack.md).

## Prerequisites (what was already present + what was added)

Already on the M4 Pro: Node 24, npm 11, Homebrew, **full Xcode 26.3** (sim iOS 18.1
& 26.3), CocoaPods 1.16, **JDK 21**, Android SDK (cmdline-tools, platform-tools,
platforms → android-36.1, build-tools, NDK, emulator + AVDs), adb, Android Studio.

Added this session:
- `brew install watchman` — Metro file watcher.
- `brew install openjdk@17` — **required** (see trap #1). Home:
  `/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.

## Project create + native dirs

```bash
npx create-expo-app@latest wallet-mobile --template default
cd wallet-mobile
# set ios.bundleIdentifier + android.package in app.json (e.g. ai.domovina.walletmobile)
npx expo prebuild --clean        # generates ios/ (+CocoaPods) and android/
```

## Build each target — locally

```bash
# WEB  → dist/ (static HTML+JS; RN-for-web → DOM)
npx expo export --platform web

# iOS  → Xcode build + boots simulator (verified live on iOS 26.3)
npx expo run:ios

# ANDROID → app/build/outputs/apk/debug/app-debug.apk (~210M debug)
cd android && ./gradlew assembleDebug
```

## Install on a physical Android device (Motorola Edge 30 Ultra, arm64-v8a)

```bash
adb devices -l                                          # confirm device authorised
adb -s <SERIAL> install -r -d app-debug.apk             # Success
adb -s <SERIAL> reverse tcp:8081 tcp:8081               # device → Metro over USB
npx expo start --port 8081 &                            # Metro must run for a DEBUG build
adb -s <SERIAL> shell monkey -p ai.domovina.walletmobile -c android.intent.category.LAUNCHER 1
# reload on device: shake, or `adb shell input keyevent 82` → Reload
# screenshot: adb -s <SERIAL> exec-out screencap -p > shot.png
```

A **debug** APK loads JS from Metro and shows a red "Could not connect" screen
without it. For a standalone offline app (JS bundled in), build **release**:
`cd android && ./gradlew assembleRelease`.

## Traps hit & fixed (read before debugging a failed build)

### 1. `JvmVendorSpec ... IBM_SEMERU` — really a missing JDK 17

`./gradlew assembleDebug` failed:
`NoSuchFieldError: JvmVendorSpec ... 'IBM_SEMERU'` at
`org.gradle.toolchains.foojay.DistributionsKt` → `...tryInstall` → `downloadToolchain`.

- **Cause:** RN 0.85 ships a Gradle **9.3.1** wrapper. RN + expo-modules-core request
  `jvmToolchain(17)`. Only JDK 21 was installed → Gradle tried to **auto-download**
  JDK 17 via foojay-resolver **0.5.0** (pinned in
  `node_modules/@react-native/gradle-plugin/settings.gradle.kts`), which references
  `JvmVendorSpec.IBM_SEMERU` — **removed in Gradle 9** → crash.
- **The tell:** the `tryInstall`/`downloadToolchain` frames — foojay only runs when a
  toolchain DOWNLOAD is needed. Bumping foojay in node_modules does **not** fix it and
  is the wrong layer.
- **Fix (durable, not in node_modules):** install JDK 17 and point Gradle at it
  globally — applies to all builds incl. included/composite builds.
  `~/.gradle/gradle.properties`:
  ```properties
  org.gradle.java.installations.auto-download=false
  org.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  ```
  Verify: build log shows `/opt/homebrew/Cellar/openjdk@17/.../bin/java`.

### 2. Gradle heap

`android/gradle.properties` default `-Xmx2048m` is tight for RN 0.85 (Hermes + NDK
native compile). Bumped to `-Xmx4096m -XX:MaxMetaspaceSize=1024m`.

### 3. "Could not receive a message from the daemon" = disk full, not OOM

After the toolchain fix the daemon died mid-build with this message. It was **ENOSPC**:
the 460 GB disk was **100 % full** (≈424 GB user data, 134 MB free); RN 0.85's first
build needs several GB. **Always `df -h /` before assuming OOM.** Freed ~33 GB of
regenerable caches (all safe — they rebuild):
```bash
rm -rf ~/Library/Developer/Xcode/iOS\ DeviceSupport   # ~20G (re-fetched on device connect)
rm -rf ~/.gradle/caches                                # ~12G (deps re-download)
rm -rf ~/Library/Caches/CocoaPods                      # ~1.1G
```
(`~/.gradle/gradle.properties` is NOT under `caches/`, so the JDK 17 config survives.)

## Result

Clean Android build: `BUILD SUCCESSFUL in 6m 7s`, `app-debug.apk` 210 MB, installed
& running on the physical Motorola. iOS ran live on the simulator. Web exported to
`dist/`. All three local, zero cloud.
