import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/options.dart';
import '../config/remote_config.dart';
import '../events/event.dart';

/// In-memory queue with automatic batch flushing and network retries.
class WebCollectionEventQueue {
  final WebCollectionOptions options;
  final List<WebCollectionEvent> _buffer = [];
  Timer? _flushTimer;
  bool _isFlushing = false;
  WebCollectionRemoteConfig? remoteConfig;

  WebCollectionEventQueue({required this.options}) {
    _startPeriodicFlush();
  }

  void _startPeriodicFlush() {
    _flushTimer?.cancel();
    _flushTimer = Timer.periodic(
      Duration(milliseconds: options.flushIntervalMs),
      (_) => flush(),
    );
  }

  /// Add event to buffer if it passes gating checks.
  void enqueue(WebCollectionEvent event) {
    if (_isEventBlocked(event)) return;

    // Buffer capacity guard: drop oldest if buffer exceeds 1000 items
    if (_buffer.length >= 1000) {
      _buffer.removeAt(0);
    }
    _buffer.add(event);

    if (_buffer.length >= options.batchSize) {
      flush();
    }
  }

  /// Check whether an event should be dropped based on local/remote config.
  bool _isEventBlocked(WebCollectionEvent event) {
    // 1. Master switch check
    final masterOn = remoteConfig?.masterSwitch ?? true;
    if (!masterOn && event.type != WebCollectionEventType.error) {
      return true; // When off, only errors bypass for emergency triage
    }

    // 2. Blacklisted event name check
    final name = event.name ?? '';
    final allBlockedEvents = [
      ...options.blockedEvents,
      if (remoteConfig != null) ...remoteConfig!.blockedEvents,
    ];
    if (name.isNotEmpty && allBlockedEvents.contains(name)) {
      return true;
    }

    // 3. Pattern check (wildcard prefix/suffix)
    final allBlockedPatterns = [
      ...options.blockedPatterns,
      if (remoteConfig != null) ...remoteConfig!.blockedPatterns,
    ];
    for (final pattern in allBlockedPatterns) {
      if (_matchPattern(name, pattern)) return true;
    }

    // 4. Error keyword check
    if (event.type == WebCollectionEventType.error) {
      final msg = (event.props['message'] ?? name).toString();
      final allBlockedErrors = [
        ...options.blockedErrors,
        if (remoteConfig != null) ...remoteConfig!.blockedErrors,
      ];
      for (final keyword in allBlockedErrors) {
        if (msg.contains(keyword)) return true;
      }
    }

    // 5. Route check
    final path = (event.props['path'] ?? '').toString();
    final allBlockedRoutes = [
      ...options.blockedRoutes,
      if (remoteConfig != null) ...remoteConfig!.blockedRoutes,
    ];
    for (final route in allBlockedRoutes) {
      if (_matchPattern(path, route)) return true;
    }

    return false;
  }

  bool _matchPattern(String input, String pattern) {
    if (pattern.isEmpty || input.isEmpty) return false;
    final regexStr = '^${RegExp.escape(pattern).replaceAll(r'\*', '.*')}\$';
    return RegExp(regexStr, caseSensitive: false).hasMatch(input);
  }

  /// Immediately flush buffered events to endpoint via HTTP POST.
  Future<void> flush() async {
    if (_isFlushing || _buffer.isEmpty) return;
    _isFlushing = true;

    final batch = List<WebCollectionEvent>.from(_buffer);
    _buffer.clear();

    try {
      final payloadList = batch.map((e) => e.toJson(
        appId: options.appId,
        release: options.release,
        extraContext: options.globalProps,
      )).toList();

      final response = await http.post(
        Uri.parse(options.endpoint),
        headers: {
          'Content-Type': 'application/json',
          'x-app-key': options.collectKey,
        },
        body: jsonEncode(payloadList),
      ).timeout(const Duration(seconds: 10));

      if (response.statusCode >= 200 && response.statusCode < 300) {
        // Successfully delivered
      } else {
        // Server error: put items back at start of buffer (respecting max limit)
        _requeueBatch(batch);
      }
    } catch (_) {
      // Network error: requeue
      _requeueBatch(batch);
    } finally {
      _isFlushing = false;
    }
  }

  void _requeueBatch(List<WebCollectionEvent> batch) {
    final combined = [...batch, ..._buffer];
    if (combined.length > 1000) {
      _buffer.clear();
      _buffer.addAll(combined.sublist(combined.length - 1000));
    } else {
      _buffer.clear();
      _buffer.addAll(combined);
    }
  }

  void dispose() {
    _flushTimer?.cancel();
  }
}
