import 'dart:async';
import '../config/options.dart';
import '../config/remote_config.dart';
import '../events/event.dart';
import '../utils/device_info.dart';
import '../utils/session.dart';
import 'queue.dart';

/// Singleton SDK client instance for Web Collection Flutter integration.
class WebCollectionClient {
  static WebCollectionClient? _instance;

  final WebCollectionOptions options;
  final WebCollectionSessionManager sessionManager;
  final WebCollectionEventQueue queue;
  final Map<String, dynamic> deviceInfo;
  bool _consentGiven = true;

  WebCollectionClient._({
    required this.options,
    required this.sessionManager,
    required this.queue,
    required this.deviceInfo,
  });

  /// Initialize SDK singleton.
  static Future<WebCollectionClient> init(WebCollectionOptions options) async {
    final sessionManager = WebCollectionSessionManager(
      timeoutMs: options.sessionTimeoutMs,
    );
    final queue = WebCollectionEventQueue(options: options);
    final deviceInfo = WebCollectionDeviceInfo.getContext();

    final client = WebCollectionClient._(
      options: options,
      sessionManager: sessionManager,
      queue: queue,
      deviceInfo: deviceInfo,
    );

    _instance = client;

    // Asynchronously fetch remote config without blocking initialization
    WebCollectionRemoteConfigFetcher.fetch(options).then((rc) {
      if (rc != null) {
        queue.remoteConfig = rc;
      }
    });

    // Record app launch start behavior event
    client.behavior('app_start', props: {'cold': true});

    return client;
  }

  /// Get active singleton instance.
  static WebCollectionClient get instance {
    if (_instance == null) {
      throw StateError('WebCollectionSdk has not been initialized. Call WebCollectionSdk.init() first.');
    }
    return _instance!;
  }

  /// Check whether client is initialized.
  static bool get isInitialized => _instance != null;

  /// Set user consent (gdpr / privacy compliance).
  void setConsent(bool consent) {
    _consentGiven = consent;
  }

  /// Explicitly rotate session ID.
  String rotateSession() {
    return sessionManager.rotateSession();
  }

  /// Track custom business event (`type: track`).
  void track(String name, {Map<String, dynamic>? props}) {
    _emit(WebCollectionEvent(
      type: WebCollectionEventType.track,
      name: name,
      props: _mergeContext(props),
      sessionId: sessionManager.sessionId,
    ));
  }

  /// Record performance metric (`type: perf`).
  void metric(String metric, num value, {Map<String, dynamic>? props}) {
    _emit(WebCollectionEvent(
      type: WebCollectionEventType.perf,
      metric: metric,
      value: value,
      props: _mergeContext(props),
      sessionId: sessionManager.sessionId,
    ));
  }

  /// Track user behavior event (`type: behavior`).
  void behavior(String name, {Map<String, dynamic>? props}) {
    _emit(WebCollectionEvent(
      type: WebCollectionEventType.behavior,
      name: name,
      props: _mergeContext(props),
      sessionId: sessionManager.sessionId,
    ));
  }

  /// Capture exception or error (`type: error`).
  void error(
    dynamic exception, [
    StackTrace? stackTrace,
    String? hint,
    Map<String, dynamic>? props,
  ]) {
    final errorProps = <String, dynamic>{
      'message': exception.toString(),
      'stack': stackTrace?.toString() ?? '',
      if (hint != null) 'hint': hint,
      ..._mergeContext(props),
    };

    _emit(WebCollectionEvent(
      type: WebCollectionEventType.error,
      name: exception.runtimeType.toString(),
      props: errorProps,
      sessionId: sessionManager.sessionId,
    ));
  }

  /// Force immediate flush of queued events.
  Future<void> flush() => queue.flush();

  void _emit(WebCollectionEvent event) {
    if (!_consentGiven) return;
    queue.enqueue(event);
  }

  Map<String, dynamic> _mergeContext(Map<String, dynamic>? userProps) {
    return {
      ...deviceInfo,
      if (userProps != null) ...userProps,
    };
  }
}
