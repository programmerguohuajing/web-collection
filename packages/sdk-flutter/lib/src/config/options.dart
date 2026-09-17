import 'dart:core';

/// Configuration options for WebCollectionSdk.
class WebCollectionOptions {
  /// Application ID registered in Web Collection platform.
  final String appId;

  /// Ingestion collection key (`x-app-key`).
  final String collectKey;

  /// Target HTTP ingestion endpoint (e.g. `https://your-domain/api/collect`).
  final String endpoint;

  /// Remote config endpoint override. If null, derived from [endpoint].
  final String? remoteConfigEndpoint;

  /// App release version (e.g. `1.0.0`).
  final String release;

  /// Session idle timeout in milliseconds before creating a new session. Default 30s (30000ms).
  final int sessionTimeoutMs;

  /// Maximum batch size before flushing queued events. Default 20.
  final int batchSize;

  /// Periodic flush interval in milliseconds. Default 10s (10000ms).
  final int flushIntervalMs;

  /// Global sampling rate (0.0 to 1.0). Default 1.0 (100%).
  final double sampleRate;

  /// Enable automatic uncaught Dart/Flutter error capturing. Default true.
  final bool enableAutoErrorTracking;

  /// Enable automatic HTTP performance capturing. Default true.
  final bool enableAutoHttpTracking;

  /// Enable automatic user pointer/touch gesture replay recording. Default true (Option 2).
  final bool enablePointerReplay;

  /// Enable automatic Widget canvas snapshot replay recording. Default false (Option 1 - User Opt-in).
  final bool enableSnapshotReplay;

  /// Snapshot interval in milliseconds if [enableSnapshotReplay] is true. Default 2000ms.
  final int snapshotIntervalMs;

  /// Snapshot image compression quality (1-100). Default 50.
  final int snapshotQuality;

  /// Exact event names to block/drop before ingestion.
  final List<String> blockedEvents;

  /// Wildcard patterns to block/drop (e.g. `debug_*`).
  final List<String> blockedPatterns;

  /// Error keywords to suppress (e.g. `ResizeObserver loop limit exceeded`).
  final List<String> blockedErrors;

  /// Page routes/paths to block from tracking.
  final List<String> blockedRoutes;

  /// Custom global properties appended to every event payload.
  final Map<String, dynamic> globalProps;

  WebCollectionOptions({
    required this.appId,
    required this.collectKey,
    this.endpoint = 'https://web-collection.jingguohua.cc.cd/api/collect',
    this.remoteConfigEndpoint,
    this.release = '1.0.0',
    this.sessionTimeoutMs = 30000,
    this.batchSize = 20,
    this.flushIntervalMs = 10000,
    this.sampleRate = 1.0,
    this.enableAutoErrorTracking = true,
    this.enableAutoHttpTracking = true,
    this.enablePointerReplay = true,
    this.enableSnapshotReplay = false,
    this.snapshotIntervalMs = 2000,
    this.snapshotQuality = 50,
    this.blockedEvents = const [],
    this.blockedPatterns = const [],
    this.blockedErrors = const [],
    this.blockedRoutes = const [],
    this.globalProps = const {},
  });

  /// Derive remote config endpoint URL (`/sdk-config` or `/api/sdk-config`).
  String get effectiveRemoteConfigEndpoint {
    if (remoteConfigEndpoint != null && remoteConfigEndpoint!.isNotEmpty) {
      return remoteConfigEndpoint!;
    }
    if (endpoint.endsWith('/api/collect')) {
      return endpoint.replaceAll('/api/collect', '/sdk-config');
    }
    if (endpoint.endsWith('/collect')) {
      return endpoint.replaceAll('/collect', '/sdk-config');
    }
    return '$endpoint/sdk-config';
  }
}
