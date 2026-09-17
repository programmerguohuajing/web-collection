import 'dart:io' show Platform;
import 'package:flutter/foundation.dart';

/// Gathers system and device contextual metadata.
class WebCollectionDeviceInfo {
  static Map<String, dynamic> getContext() {
    String osName = 'unknown';
    String osVersion = '';

    if (kIsWeb) {
      osName = 'web';
    } else if (Platform.isAndroid) {
      osName = 'android';
      osVersion = Platform.operatingSystemVersion;
    } else if (Platform.isIOS) {
      osName = 'ios';
      osVersion = Platform.operatingSystemVersion;
    } else if (Platform.isMacOS) {
      osName = 'macos';
      osVersion = Platform.operatingSystemVersion;
    } else if (Platform.isWindows) {
      osName = 'windows';
      osVersion = Platform.operatingSystemVersion;
    } else if (Platform.isLinux) {
      osName = 'linux';
      osVersion = Platform.operatingSystemVersion;
    }

    return {
      'os_name': osName,
      'os_version': osVersion,
      'is_web': kIsWeb,
      'debug_mode': kDebugMode,
    };
  }
}
