import 'package:test/test.dart';
import 'package:web_collection_sdk/src/config/options.dart';

void main() {
  group('Flutter Session Replay Dual-Mode Options', () {
    test('default options enable pointer replay and disable snapshot replay', () {
      final options = WebCollectionOptions(
        appId: 'test_app',
        collectKey: 'key_123',
      );

      expect(options.enablePointerReplay, isTrue); // Option 2: Default Enabled
      expect(options.enableSnapshotReplay, isFalse); // Option 1: User Opt-in Default Disabled
      expect(options.snapshotIntervalMs, equals(2000));
      expect(options.snapshotQuality, equals(50));
    });

    test('user can explicitly opt-in to snapshot replay mode', () {
      final options = WebCollectionOptions(
        appId: 'test_app',
        collectKey: 'key_123',
        enableSnapshotReplay: true,
        snapshotIntervalMs: 1500,
        snapshotQuality: 70,
      );

      expect(options.enableSnapshotReplay, isTrue);
      expect(options.snapshotIntervalMs, equals(1500));
      expect(options.snapshotQuality, equals(70));
    });
  });
}
