import 'dart:ui';
import 'package:flutter/foundation.dart';
import '../core/client.dart';

/// Integrates automatic Dart & Flutter uncaught exception capturing.
class WebCollectionErrorIntegration {
  static void attach() {
    // 1. Capture Flutter framework widget & render errors
    final originalFlutterError = FlutterError.onError;
    FlutterError.onError = (FlutterErrorDetails details) {
      if (WebCollectionClient.isInitialized) {
        WebCollectionClient.instance.error(
          details.exception,
          details.stack,
          'flutter_framework_error',
          {
            'library': details.library ?? 'flutter',
            'context': details.context?.toString(),
          },
        );
      }
      originalFlutterError?.call(details);
    };

    // 2. Capture async & isolate platform errors
    final originalPlatformError = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (Object error, StackTrace stack) {
      if (WebCollectionClient.isInitialized) {
        WebCollectionClient.instance.error(
          error,
          stack,
          'platform_dispatcher_error',
        );
      }
      return originalPlatformError?.call(error, stack) ?? true;
    };
  }
}
