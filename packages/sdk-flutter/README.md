# `@web-collection/sdk-flutter`

Official Flutter & Dart SDK for Web Collection APM & Telemetry Platform.

Supports **Flutter Mobile (iOS / Android)**, **Flutter Web**, and **Flutter Desktop**.

---

## 📦 Installation

Add `web_collection_sdk` to your `pubspec.yaml`:

```yaml
dependencies:
  web_collection_sdk:
    path: ../packages/sdk-flutter
  http: ^1.1.0
```

---

## 🎬 Dual-Mode Session Replay

Flutter renders UI directly via Skia/Impeller Canvas instead of Web DOM. The SDK provides two replay modes:

| Mode | Mechanism | Default | Overhead |
| :--- | :--- | :---: | :---: |
| **Option 2: Pointer Event Replay** (`WebCollectionPointerListener`) | Touch `(x, y)` coordinates & gestures | **Enabled (Default)** | ~0 CPU (Ultra-light) |
| **Option 1: Canvas Snapshot Replay** (`WebCollectionRepaintBoundary`) | Low-framerate Widget image snapshots | **Disabled (User Opt-in)** | Render Dependent |

### Enabling Option 1 (Canvas Snapshot Replay)

```dart
// 1. Enable in options
WebCollectionOptions(
  enableSnapshotReplay: true,
  snapshotIntervalMs: 2000,
);

// 2. Wrap root widget
runApp(
  const WebCollectionRepaintBoundary(
    child: MyApp(),
  ),
);
```

---

## 🚀 Quickstart

```dart
import 'package:flutter/material.dart';
import 'package:web_collection_sdk/web_collection_sdk.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await WebCollectionSdk.init(
    options: WebCollectionOptions(
      appId: 'your_flutter_app_id',
      collectKey: 'your_collect_key',
      endpoint: 'https://web-collection.jingguohua.cc.cd/api/collect',
      release: '1.0.0',
    ),
  );

  runApp(
    const WebCollectionPointerListener(
      child: MyApp(),
    ),
  );
}
```
