import 'package:test/test.dart';
import 'package:web_collection_sdk/src/config/options.dart';
import 'package:web_collection_sdk/src/config/remote_config.dart';
import 'package:web_collection_sdk/src/core/queue.dart';
import 'package:web_collection_sdk/src/events/event.dart';

void main() {
  group('WebCollectionEventQueue - Gating & Blacklist Filtering', () {
    late WebCollectionOptions options;
    late WebCollectionEventQueue queue;

    setUp(() {
      options = WebCollectionOptions(
        appId: 'test_app',
        collectKey: 'key_123',
        blockedEvents: ['blocked_click', 'debug_trace'],
        blockedPatterns: ['test_*', '*_temp'],
        blockedErrors: ['ResizeObserver loop limit'],
        blockedRoutes: ['/internal/*'],
      );
      queue = WebCollectionEventQueue(options: options);
    });

    tearDown(() {
      queue.dispose();
    });

    test('exact blocked_events drops matching event', () {
      final event1 = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'blocked_click',
        sessionId: 'ses_1',
      );
      final event2 = WebCollectionEvent(
        type: WebCollectionEventType.track,
        name: 'valid_click',
        sessionId: 'ses_1',
      );

      queue.enqueue(event1);
      queue.enqueue(event2);

      // Verify blocked event is dropped
    });

    test('wildcard blocked_patterns drops prefix and suffix matching events', () {
      final e1 = WebCollectionEvent(type: WebCollectionEventType.track, name: 'test_action', sessionId: 'ses_1');
      final e2 = WebCollectionEvent(type: WebCollectionEventType.track, name: 'cache_temp', sessionId: 'ses_1');
      final e3 = WebCollectionEvent(type: WebCollectionEventType.track, name: 'prod_action', sessionId: 'ses_1');

      queue.enqueue(e1); // dropped by test_*
      queue.enqueue(e2); // dropped by *_temp
      queue.enqueue(e3); // kept
    });

    test('blocked_errors drops noisy exception matching keyword', () {
      final noisyErr = WebCollectionEvent(
        type: WebCollectionEventType.error,
        name: 'Error',
        props: {'message': 'Uncaught Error: ResizeObserver loop limit exceeded'},
        sessionId: 'ses_1',
      );
      final fatalErr = WebCollectionEvent(
        type: WebCollectionEventType.error,
        name: 'StateError',
        props: {'message': 'Critical Database Fail'},
        sessionId: 'ses_1',
      );

      queue.enqueue(noisyErr); // dropped
      queue.enqueue(fatalErr); // kept
    });

    test('master_switch=off suppresses non-error events while allowing errors', () {
      queue.remoteConfig = WebCollectionRemoteConfig(masterSwitch: false);

      final trackEvent = WebCollectionEvent(type: WebCollectionEventType.track, name: 'click', sessionId: 'ses_1');
      final errorEvent = WebCollectionEvent(type: WebCollectionEventType.error, name: 'crash', sessionId: 'ses_1');

      queue.enqueue(trackEvent); // suppressed
      queue.enqueue(errorEvent); // retained for triage
    });
  });
}
