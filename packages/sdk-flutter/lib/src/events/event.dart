import 'dart:core';

/// Supported event types in Web Collection Schema.
enum WebCollectionEventType {
  track,
  perf,
  behavior,
  error,
  log,
  replay,
}

extension WebCollectionEventTypeExtension on WebCollectionEventType {
  String get value {
    switch (this) {
      case WebCollectionEventType.track:
        return 'track';
      case WebCollectionEventType.perf:
        return 'perf';
      case WebCollectionEventType.behavior:
        return 'behavior';
      case WebCollectionEventType.error:
        return 'error';
      case WebCollectionEventType.log:
        return 'log';
      case WebCollectionEventType.replay:
        return 'replay';
    }
  }
}

/// Telemetry event structure matching Web Collection schema.
class WebCollectionEvent {
  final WebCollectionEventType type;
  final String? name;
  final String? metric;
  final num? value;
  final Map<String, dynamic> props;
  final String sessionId;
  final int ts;

  WebCollectionEvent({
    required this.type,
    this.name,
    this.metric,
    this.value,
    Map<String, dynamic>? props,
    required this.sessionId,
    int? ts,
  })  : props = props != null ? Map<String, dynamic>.from(props) : {},
        ts = ts ?? DateTime.now().millisecondsSinceEpoch;

  /// Convert event to JSON map conforming to /api/collect payload.
  Map<String, dynamic> toJson({
    required String appId,
    required String release,
    Map<String, dynamic>? extraContext,
  }) {
    final Map<String, dynamic> mergedProps = {
      ...props,
      if (extraContext != null) ...extraContext,
      'platform': 'flutter',
      'sdk_name': 'flutter',
      'sdk_version': '0.8.0',
      'app_id': appId,
      'app_version': release,
    };

    final map = <String, dynamic>{
      'type': type.value,
      'sessionId': sessionId,
      'ts': ts,
      'props': _sanitizeProps(mergedProps),
    };

    if (name != null && name!.isNotEmpty) {
      map['name'] = name!.length > 160 ? name!.substring(0, 160) : name;
    }
    if (metric != null && metric!.isNotEmpty) {
      map['metric'] = metric!.length > 32 ? metric!.substring(0, 32) : metric;
    }
    if (value != null) {
      map['value'] = value;
    }

    return map;
  }

  /// Truncate property keys and string values to conform to schema bounds.
  static Map<String, dynamic> _sanitizeProps(Map<String, dynamic> raw) {
    final result = <String, dynamic>{};
    int count = 0;

    for (final entry in raw.entries) {
      if (count >= 80) break; // Maximum 80 properties per event
      final key = entry.key.length > 64 ? entry.key.substring(0, 64) : entry.key;
      final val = entry.value;

      if (val == null) continue;

      if (val is String) {
        result[key] = val.length > 1000 ? val.substring(0, 1000) : val;
      } else if (val is num || val is bool) {
        result[key] = val;
      } else {
        final str = val.toString();
        result[key] = str.length > 1000 ? str.substring(0, 1000) : str;
      }
      count++;
    }

    return result;
  }
}
