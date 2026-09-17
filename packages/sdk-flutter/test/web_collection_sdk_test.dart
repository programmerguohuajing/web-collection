import 'package:test/test.dart';
import 'package:web_collection_sdk/src/config/options.dart';
import 'package:web_collection_sdk/src/events/event.dart';
import 'package:web_collection_sdk/src/utils/session.dart';

void main() {
  group('WebCollectionOptions', () {
    test('default option values', () {
      final options = WebCollectionOptions(
        appId: 'test_app',
        collectKey: 'key_123',
      );

      expect(options.appId, equals('test_app'));
      expect(options.collectKey, equals('key_123'));
      expect(options.sampleRate, equals(1.0));
      expect(options.batchSize, equals(20));
      expect(options.effectiveRemoteConfigEndpoint, equals('https://web-collection.jingguohua.cc.cd/sdk-config'));
    });
  });

  group('WebCollectionSessionManager', () {
    test('generate and rotate session id', () {
      final manager = WebCollectionSessionManager(timeoutMs: 30000);
      final initialId = manager.sessionId;

      expect(initialId.startsWith('ses_'), isTrue);

      final rotatedId = manager.rotateSession();
      expect(rotatedId.startsWith('ses_'), isTrue);
      expect(rotatedId, isNot(equals(initialId)));
    });
  });

  group('WebCollectionEvent', () {
    test('serialization conforms to API schema', () {
      final event = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'test_click',
        props: {'btn': 'submit'},
        sessionId: 'ses_123',
        ts: 1726588800000,
      );

      final json = event.toJson(appId: 'test_app', release: '1.0.0');

      expect(json['type'], equals('track'));
      expect(json['name'], equals('test_click'));
      expect(json['sessionId'], equals('ses_123'));
      expect(json['ts'], equals(1726588800000));
      expect(json['props']['btn'], equals('submit'));
      expect(json['props']['platform'], equals('flutter'));
      expect(json['props']['sdk_name'], equals('flutter'));
    });
  });
}
