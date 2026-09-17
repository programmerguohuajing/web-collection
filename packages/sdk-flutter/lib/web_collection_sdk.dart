library web_collection_sdk;

import 'dart:async';
import 'src/config/options.dart';
import 'src/core/client.dart';
import 'src/integrations/error_integration.dart';

export 'src/config/options.dart';
export 'src/core/client.dart';
export 'src/events/event.dart';
export 'src/integrations/http_client.dart';
export 'src/integrations/pointer_integration.dart';
export 'src/integrations/route_observer.dart';
export 'src/integrations/snapshot_integration.dart';

/// Facade entry point for Web Collection Flutter SDK.
class WebCollectionSdk {
  /// Initialize Web Collection SDK.
  ///
  /// ```dart
  /// await WebCollectionSdk.init(
  ///   options: WebCollectionOptions(
  ///     appId: 'my_flutter_app',
  ///     collectKey: 'eys_key_xxx',
  ///     endpoint: 'https://web-collection.jingguohua.cc.cd/api/collect',
  ///   ),
  /// );
  /// ```
  static Future<WebCollectionClient> init({
    required WebCollectionOptions options,
  }) async {
    final client = await WebCollectionClient.init(options);

    if (options.enableAutoErrorTracking) {
      WebCollectionErrorIntegration.attach();
    }

    return client;
  }

  /// Track a custom business event (`type: track`).
  static void track(String name, {Map<String, dynamic>? props}) {
    WebCollectionClient.instance.track(name, props: props);
  }

  /// Record a performance metric (`type: perf`).
  static void metric(String metric, num value, {Map<String, dynamic>? props}) {
    WebCollectionClient.instance.metric(metric, value, props: props);
  }

  /// Track a user behavior event (`type: behavior`).
  static void behavior(String name, {Map<String, dynamic>? props}) {
    WebCollectionClient.instance.behavior(name, props: props);
  }

  /// Manually capture an exception or error (`type: error`).
  static void error(
    dynamic exception, [
    StackTrace? stackTrace,
    String? hint,
    Map<String, dynamic>? props,
  ]) {
    WebCollectionClient.instance.error(exception, stackTrace, hint, props);
  }

  /// Explicitly rotate the session ID.
  static String rotateSession() {
    return WebCollectionClient.instance.rotateSession();
  }

  /// Set user privacy consent status.
  static void setConsent(bool consent) {
    WebCollectionClient.instance.setConsent(consent);
  }

  /// Immediately flush all buffered events to server.
  static Future<void> flush() {
    return WebCollectionClient.instance.flush();
  }
}
