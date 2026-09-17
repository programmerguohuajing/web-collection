# `@web-collection/sdk-flutter` (Dart / Flutter SDK)

Web Collection 全链路性能与数据可观测平台的官方 Flutter / Dart 原生 SDK。

支持 **Flutter Mobile (iOS / Android)**、**Flutter Web** 与 **Flutter Desktop**。

---

## 📦 快速安装

在 Flutter 项目的 `pubspec.yaml` 中添加依赖：

```yaml
dependencies:
  web_collection_sdk:
    path: ../packages/sdk-flutter # 或使用 Git 仓库 / Pub 托管路径
  http: ^1.1.0
```

---

## 🚀 快速接入

### 1. 初始化 SDK

在 `main.dart` 启动入口完成初始化：

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
      enableAutoErrorTracking: true,
      enableAutoHttpTracking: true,
    ),
  );

  runApp(const MyApp());
}
```

---

## 🛠️ 自动化采集

### 1. 自动路由与页面停留时间 (PV & Page Leave)
在 `MaterialApp` 的 `navigatorObservers` 中注入 `WebCollectionRouteObserver`：

```dart
final WebCollectionRouteObserver routeObserver = WebCollectionRouteObserver();

MaterialApp(
  navigatorObservers: [routeObserver],
  // ...
);
```

### 2. 自动网络请求性能 (HTTP Latency)
使用 `WebCollectionHttpClient` 包装原生 `http.Client`：

```dart
final client = WebCollectionHttpClient();
final response = await client.get(Uri.parse('https://api.example.com/data'));
```

### 3. 自动崩溃与未捕获异常
初始化时设置 `enableAutoErrorTracking: true`，即可自动接管 `FlutterError.onError` 与 `PlatformDispatcher.instance.onError`。

---

## 📊 手动上报 API

```dart
// 1. 业务自定义埋点 (track)
WebCollectionSdk.track('purchase_success', props: {
  'order_id': 'ord_123456',
  'amount': 199.00,
});

// 2. 性能指标 (perf)
WebCollectionSdk.metric('image_load_duration', 350, props: {
  'image_url': 'https://static.example.com/banner.png',
});

// 3. 用户行为 (behavior)
WebCollectionSdk.behavior('click_banner', props: {
  'banner_id': 'home_top_1',
});

// 4. 手动报错上报 (error)
try {
  // 某些可能抛异常的代码...
} catch (e, stack) {
  WebCollectionSdk.error(e, stack, '数据解析失败', {'raw_data': raw});
}

// 5. 主动刷盘/立即上报
await WebCollectionSdk.flush();
```

---

## 🔒 隐私与合规 (GDPR & Consent)

```dart
// 用户拒绝隐私协议时关闭采集
WebCollectionSdk.setConsent(false);

// 用户同意后恢复采集
WebCollectionSdk.setConsent(true);
```
