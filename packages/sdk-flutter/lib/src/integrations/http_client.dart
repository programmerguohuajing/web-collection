import 'dart:async';
import 'package:http/http.dart' as http;
import '../core/client.dart';

/// Wrapped HTTP Client that automatically captures APM network latency (`metric: fetch`).
class WebCollectionHttpClient extends http.BaseClient {
  final http.Client _inner;

  WebCollectionHttpClient([http.Client? inner]) : _inner = inner ?? http.Client();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final startTime = DateTime.now().millisecondsSinceEpoch;
    int statusCode = 0;
    int responseSize = 0;
    String? errorType;

    try {
      final response = await _inner.send(request);
      statusCode = response.statusCode;
      responseSize = response.contentLength ?? 0;
      return response;
    } catch (e) {
      errorType = e.runtimeType.toString();
      rethrow;
    } finally {
      final duration = DateTime.now().millisecondsSinceEpoch - startTime;

      if (WebCollectionClient.isInitialized) {
        final statusClass = statusCode > 0 ? '${(statusCode / 100).floor()}xx' : 'error';
        WebCollectionClient.instance.metric(
          'fetch',
          duration,
          props: {
            'url': request.url.toString(),
            'method': request.method,
            'status': statusCode,
            'statusClass': statusClass,
            'responseSize': responseSize,
            if (errorType != null) 'errorType': errorType,
          },
        );
      }
    }
  }

  @override
  void close() {
    _inner.close();
    super.close();
  }
}
