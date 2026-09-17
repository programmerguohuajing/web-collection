import 'package:test/test.dart';
import 'package:web_collection_sdk/src/utils/session.dart';

void main() {
  group('WebCollectionSessionManager - Session Lifecycle Tests', () {
    test('session ID format starts with ses_ prefix', () {
      final manager = WebCollectionSessionManager(timeoutMs: 30000);
      final id = manager.sessionId;
      expect(id.startsWith('ses_'), isTrue);
      expect(id.split('_').length, equals(3));
    });

    test('manual rotateSession() generates new distinct session ID', () {
      final manager = WebCollectionSessionManager(timeoutMs: 30000);
      final id1 = manager.sessionId;
      final id2 = manager.rotateSession();

      expect(id2.startsWith('ses_'), isTrue);
      expect(id2, isNot(equals(id1)));
      expect(manager.sessionId, equals(id2));
    });

    test('session auto-rotates after timeout duration expires', () async {
      final manager = WebCollectionSessionManager(timeoutMs: 50); // 50ms timeout for test
      final id1 = manager.sessionId;

      await Future.delayed(const Duration(milliseconds: 70));

      final id2 = manager.sessionId;
      expect(id2, isNot(equals(id1)));
    });

    test('touch() activity prevents session timeout', () async {
      final manager = WebCollectionSessionManager(timeoutMs: 100);
      final id1 = manager.sessionId;

      await Future.delayed(const Duration(milliseconds: 60));
      manager.touch(); // Keep active
      await Future.delayed(const Duration(milliseconds: 60));

      final id2 = manager.sessionId;
      expect(id2, equals(id1));
    });
  });
}
