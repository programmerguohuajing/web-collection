import 'package:test/test.dart';
import 'package:web_collection_sdk/src/events/event.dart';

void main() {
  group('WebCollectionEvent - Boundary & Serialization Tests', () {
    test('standard event serialization contains required top-level keys', () {
      final event = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'user_login',
        props: {'method': 'phone'},
        sessionId: 'ses_123456',
        ts: 1700000000000,
      );

      final json = event.toJson(appId: 'demo_app', release: '1.2.0');

      expect(json['type'], equals('track'));
      expect(json['name'], equals('user_login'));
      expect(json['sessionId'], equals('ses_123456'));
      expect(json['ts'], equals(1700000000000));
      expect(json['props']['method'], equals('phone'));
      expect(json['props']['app_id'], equals('demo_app'));
      expect(json['props']['app_version'], equals('1.2.0'));
      expect(json['props']['platform'], equals('flutter'));
    });

    test('name field is truncated if it exceeds 160 characters', () {
      final longName = 'A' * 200;
      final event = WebCollectionEvent(
        type: WebCollectionEventType.behavior,
        name: longName,
        sessionId: 'ses_123',
      );

      final json = event.toJson(appId: 'app', release: '1.0.0');
      expect(json['name'].length, equals(160));
    });

    test('metric field is truncated if it exceeds 32 characters', () {
      final longMetric = 'M' * 50;
      final event = WebCollectionEvent(
        type: WebCollectionEventType.perf,
        metric: longMetric,
        value: 123.4,
        sessionId: 'ses_123',
      );

      final json = event.toJson(appId: 'app', release: '1.0.0');
      expect(json['metric'].length, equals(32));
      expect(json['value'], equals(123.4));
    });

    test('property string values exceeding 1000 characters are safely truncated', () {
      final longValue = 'X' * 1500;
      final event = WebCollectionEvent(
        type: WebCollectionEventType.error,
        name: 'Exception',
        props: {'stackTrace': longValue},
        sessionId: 'ses_123',
      );

      final json = event.toJson(appId: 'app', release: '1.0.0');
      expect((json['props']['stackTrace'] as String).length, equals(1000));
    });

    test('properties count limit enforces maximum of 80 keys', () {
      final Map<String, dynamic> hugeProps = {};
      for (int i = 0; i < 100; i++) {
        hugeProps['key_$i'] = 'val_$i';
      }

      final event = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'bulk_event',
        props: hugeProps,
        sessionId: 'ses_123',
      );

      final json = event.toJson(appId: 'app', release: '1.0.0');
      final Map propsMap = json['props'] as Map;
      // 80 custom keys + default platform keys
      expect(propsMap.keys.length, lessThanOrEqualTo(85));
    });

    test('null property values are omitted from payload', () {
      final event = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'test_null',
        props: {'valid': '123', 'invalid': null},
        sessionId: 'ses_123',
      );

      final json = event.toJson(appId: 'app', release: '1.0.0');
      expect(json['props'].containsKey('valid'), isTrue);
      expect(json['props'].containsKey('invalid'), isFalse);
    });
  });
}
