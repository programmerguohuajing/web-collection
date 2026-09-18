# Changelog

## 0.8.1

- Patch release aligned with Web Collection v0.8.1.
- Includes release automation and packaging metadata fixes for pub.dev/GitHub Release.
- No breaking Flutter SDK API changes.

All notable changes to `web_collection_sdk` (Flutter SDK) will be documented in this file.

## 0.8.0

- Initial release of official `web_collection_sdk` Flutter/Dart SDK.
- Automatic crash reporting via `FlutterError.onError` and `PlatformDispatcher.onError`.
- Route navigation tracking via `WebCollectionRouteObserver`.
- HTTP network performance monitoring with `WebCollectionHttpClient`.
- Session Replay Dual-Mode Support:
  - Mode 2 (Default): Pointer touch gesture tracking (`WebCollectionPointerListener`).
  - Mode 1 (Opt-in): Widget canvas image snapshot recording (`WebCollectionRepaintBoundary`).
