// plugins/withSqliteVec.js  — P2: Expo config plugin for sqlite-vec native extension
//
// This plugin copies the pre-compiled sqlite-vec shared libraries (.so / .dylib)
// into the correct locations inside the native Android and iOS projects during
// `npx expo prebuild`.
//
// SETUP:
//   1. Create native-libs directories and download the binaries (run once):
//
//      mkdir -p native-libs/android/arm64-v8a
//      mkdir -p native-libs/android/x86_64
//      mkdir -p native-libs/android/armeabi-v7a
//      mkdir -p native-libs/android/x86
//      mkdir -p native-libs/ios
//
//      # Android ARM64 (physical devices — most common)
//      curl -L https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/vec0-android-arm64-v8a.so \
//           -o native-libs/android/arm64-v8a/vec0.so
//
//      # Android x86_64 (emulators)
//      curl -L https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/vec0-android-x86_64.so \
//           -o native-libs/android/x86_64/vec0.so
//
//      # iOS
//      curl -L https://github.com/asg017/sqlite-vec/releases/download/v0.1.6/vec0-ios.dylib \
//           -o native-libs/ios/vec0.dylib
//
//   2. Register this plugin in app.json (see app.json diff in P2 section).
//
//   3. Run: npx expo prebuild --clean
//
//   4. Verify:
//      ls android/app/src/main/jniLibs/arm64-v8a/vec0.so   # must exist
//
//   5. Launch app — Logcat/Metro should show:
//      [DB] sqlite-vec extension loaded ✓
//
// COMMIT: Commit the native-libs/ binaries to git — they pin the extension to
//         a specific release for reproducible builds.

const { withDangerousMod } = require('@expo/config-plugins');
const fs   = require('fs');
const path = require('path');

// ── Android: copy .so files into jniLibs/<abi>/ ───────────────────────────

const withSqliteVecAndroid = (config) =>
  withDangerousMod(config, [
    'android',
    async (config) => {
      const abis = ['arm64-v8a', 'x86_64', 'armeabi-v7a', 'x86'];

      for (const abi of abis) {
        const src = path.join(
          __dirname, '..', 'native-libs', 'android', abi, 'vec0.so'
        );
        const dest = path.join(
          config.modRequest.platformProjectRoot,
          'app', 'src', 'main', 'jniLibs', abi, 'vec0.so'
        );

        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          console.log(`[withSqliteVec] ✓ Android ${abi} → ${dest}`);
        } else {
          // Not all ABIs need to be present — warn but don't fail
          console.log(`[withSqliteVec] ⚠ No binary for ${abi} (${src} not found) — skipping`);
        }
      }

      return config;
    },
  ]);

// ── iOS: copy .dylib into the Xcode project directory ─────────────────────

const withSqliteVecIos = (config) =>
  withDangerousMod(config, [
    'ios',
    async (config) => {
      const src = path.join(
        __dirname, '..', 'native-libs', 'ios', 'vec0.dylib'
      );
      const dest = path.join(
        config.modRequest.platformProjectRoot,
        config.modRequest.projectName,
        'vec0.dylib'
      );

      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`[withSqliteVec] ✓ iOS dylib → ${dest}`);
      } else {
        console.log(`[withSqliteVec] ⚠ iOS binary not found at ${src} — skipping`);
      }

      return config;
    },
  ]);

// Export combined plugin — Expo applies both in a single prebuild run
module.exports = (config) => withSqliteVecIos(withSqliteVecAndroid(config));