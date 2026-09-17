import 'package:flutter/widgets.dart';
import '../core/client.dart';
import '../events/event.dart';

/// Integrates touch & gesture pointer event replay recording (Option 2 - Default).
class WebCollectionPointerListener extends StatelessWidget {
  final Widget child;

  const WebCollectionPointerListener({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    if (!WebCollectionClient.isInitialized ||
        !WebCollectionClient.instance.options.enablePointerReplay) {
      return child;
    }

    return Listener(
      onPointerDown: (event) => _recordPointer('down', event),
      onPointerMove: (event) => _recordPointer('move', event),
      onPointerUp: (event) => _recordPointer('up', event),
      behavior: HitTestBehavior.translucent,
      child: child,
    );
  }

  void _recordPointer(String kind, PointerEvent event) {
    if (!WebCollectionClient.isInitialized) return;

    WebCollectionClient.instance.queue.enqueue(
      WebCollectionEvent(
        type: WebCollectionEventType.replay,
        name: 'pointer_event',
        props: {
          'kind': kind,
          'pointer_id': event.pointer,
          'x': double.parse(event.position.dx.toStringAsFixed(1)),
          'y': double.parse(event.position.dy.toStringAsFixed(1)),
          'device_kind': event.kind.toString(),
        },
        sessionId: WebCollectionClient.instance.sessionManager.sessionId,
      ),
    );
  }
}
