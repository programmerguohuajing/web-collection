import 'package:test/test.dart';
import 'package:web_collection_sdk/src/config/options.dart';
import 'package:web_collection_sdk/src/core/client.dart';

void main() {
  group('WebCollectionClient - Initialization & Facade API', () {
    test('uninitialized instance throws StateError', () {
      expect(() => WebCollectionClient.instance, throwsA(isA<StateError>()));
      expect(WebCollectionClient.isInitialized, isFalse);
    });

    test('init() initializes client singleton', () async {
      final options = WebCollectionOptions(
        appId: 'demo_app',
        collectKey: 'eys_key_demo',
      );

      final client = await WebCollectionClient.init(options);

      expect(WebCollectionClient.isInitialized, isTrue);
      expect(WebCollectionClient.instance, equals(client));
      expect(client.options.appId, equals('demo_app'));
    });

    test('setConsent(false) disables event emissions', () async {
      final options = WebCollectionOptions(
        appId: 'consent_app',
        collectKey: 'key_123',
      );

      final client = await WebCollectionClient.init(options);
      client.setConsent(false);

      // Triggers no-op when consent is revoked
      client.track('test_event');
    });
  });
}
