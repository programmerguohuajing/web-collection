import 'dart:convert';
import 'package:http/http.dart' as http;
import 'options.dart';

/// Parsed remote configuration state from GET /sdk-config.
class WebCollectionRemoteConfig {
  final bool masterSwitch;
  final Map<String, double> sampling;
  final List<String> blockedEvents;
  final List<String> blockedPatterns;
  final List<String> blockedErrors;
  final List<String> blockedRoutes;

  WebCollectionRemoteConfig({
    this.masterSwitch = true,
    this.sampling = const {'error': 1.0, 'performance': 1.0, 'replay': 1.0, 'behavior': 1.0},
    this.blockedEvents = const [],
    this.blockedPatterns = const [],
    this.blockedErrors = const [],
    this.blockedRoutes = const [],
  });

  factory WebCollectionRemoteConfig.fromJson(Map<String, dynamic> json) {
    final master = json['master_switch'] != 'off';

    final samplingMap = <String, double>{};
    if (json['sampling'] is Map) {
      (json['sampling'] as Map).forEach((key, val) {
        if (val is num) {
          samplingMap[key.toString()] = val.toDouble();
        }
      });
    }

    List<String> parseList(dynamic raw) {
      if (raw is List) {
        return raw.map((e) => e.toString().trim()).where((e) => e.isNotEmpty).toList();
      }
      return [];
    }

    return WebCollectionRemoteConfig(
      masterSwitch: master,
      sampling: samplingMap.isEmpty ? {'error': 1.0, 'performance': 1.0, 'replay': 1.0, 'behavior': 1.0} : samplingMap,
      blockedEvents: parseList(json['blocked_events']),
      blockedPatterns: parseList(json['blocked_patterns']),
      blockedErrors: parseList(json['blocked_errors']),
      blockedRoutes: parseList(json['blocked_routes']),
    );
  }
}

/// Asynchronously fetches remote config from server with failure-safety.
class WebCollectionRemoteConfigFetcher {
  static Future<WebCollectionRemoteConfig?> fetch(WebCollectionOptions options) async {
    try {
      final url = Uri.parse('${options.effectiveRemoteConfigEndpoint}?appId=${options.appId}&sdkVersion=0.1.0&appVersion=${options.release}');
      final response = await http.get(url, headers: {
        'x-app-key': options.collectKey,
        'Accept': 'application/json',
      }).timeout(const Duration(seconds: 3));

      if (response.statusCode == 200) {
        final Map<String, dynamic> body = jsonDecode(response.body);
        return WebCollectionRemoteConfig.fromJson(body);
      }
    } catch (_) {
      // Failure safety: return null on error or timeout, SDK falls back to local options.
    }
    return null;
  }
}
