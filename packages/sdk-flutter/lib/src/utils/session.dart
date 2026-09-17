import 'dart:math';

/// Manages session lifecycle and rotation for Flutter SDK.
class WebCollectionSessionManager {
  final int timeoutMs;
  late String _sessionId;
  int _lastActiveTs;

  WebCollectionSessionManager({this.timeoutMs = 30000})
      : _lastActiveTs = DateTime.now().millisecondsSinceEpoch {
    _sessionId = _generateSessionId();
  }

  /// Get current session ID, auto-rotating if idle timeout exceeded.
  String get sessionId {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (now - _lastActiveTs > timeoutMs) {
      rotateSession();
    } else {
      _lastActiveTs = now;
    }
    return _sessionId;
  }

  /// Explicitly update activity timestamp.
  void touch() {
    _lastActiveTs = DateTime.now().millisecondsSinceEpoch;
  }

  /// Explicitly rotate session ID (e.g. on route change or user logout).
  String rotateSession() {
    _sessionId = _generateSessionId();
    _lastActiveTs = DateTime.now().millisecondsSinceEpoch;
    return _sessionId;
  }

  static String _generateSessionId() {
    final rand = Random().nextInt(0xFFFFFF).toRadixString(16).padLeft(6, '0');
    final ts = DateTime.now().millisecondsSinceEpoch;
    return 'ses_${ts}_$rand';
  }
}
