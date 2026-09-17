import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import '../core/client.dart';
import '../events/event.dart';

/// Integrates Widget Canvas Image Snapshot replay recording (Option 1 - User Opt-in).
class WebCollectionRepaintBoundary extends StatefulWidget {
  final Widget child;

  const WebCollectionRepaintBoundary({super.key, required this.child});

  @override
  State<WebCollectionRepaintBoundary> createState() => _WebCollectionRepaintBoundaryState();
}

class _WebCollectionRepaintBoundaryState extends State<WebCollectionRepaintBoundary> {
  final GlobalKey _boundaryKey = GlobalKey();
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _setupSnapshotTimer();
  }

  void _setupSnapshotTimer() {
    if (!WebCollectionClient.isInitialized) return;
    final options = WebCollectionClient.instance.options;

    if (options.enableSnapshotReplay) {
      _timer?.cancel();
      _timer = Timer.periodic(
        Duration(milliseconds: options.snapshotIntervalMs),
        (_) => captureSnapshot(),
      );
    }
  }

  /// Manually or automatically capture canvas snapshot and emit replay event.
  Future<void> captureSnapshot() async {
    if (!WebCollectionClient.isInitialized) return;

    try {
      final boundary = _boundaryKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary == null || boundary.debugNeedsPaint) return;

      final image = await boundary.toImage(pixelRatio: 0.5); // 0.5x scaling to save bandwidth
      final byteData = await image.toByteData(format: ui.ImageByteFormat.png);

      if (byteData == null) return;

      final base64Image = base64Encode(byteData.buffer.asUint8List());

      WebCollectionClient.instance.queue.enqueue(
        WebCollectionEvent(
          type: WebCollectionEventType.replay,
          name: 'canvas_snapshot',
          props: {
            'snapshot_type': 'image_png',
            'width': image.width,
            'height': image.height,
            'image_data': base64Image,
          },
          sessionId: WebCollectionClient.instance.sessionManager.sessionId,
        ),
      );
    } catch (_) {
      // Safe no-op on capture failure or unpainted state
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      key: _boundaryKey,
      child: child,
    );
  }
}
