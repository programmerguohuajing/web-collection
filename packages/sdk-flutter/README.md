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

  runApp(const MyApp());
}
```

---

## 🛠️ Automatic Telemetry

- **Route Tracking**: Register `WebCollectionRouteObserver` in `MaterialApp.navigatorObservers`.
- **HTTP Monitoring**: Wrap your client with `WebCollectionHttpClient()`.
- **Uncaught Errors**: Automatically enabled via `enableAutoErrorTracking: true`.

---

## 📊 Manual Event Tracking

```dart
WebCollectionSdk.track('event_name', props: {'key': 'value'});
WebCollectionSdk.metric('metric_name', 123.45);
WebCollectionSdk.behavior('user_action');
WebCollectionSdk.error(exception, stackTrace);
```
