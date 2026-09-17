import 'package:flutter/widgets.dart';
import '../core/client.dart';

/// RouteObserver for automatically capturing Flutter Navigator page views (`pv`) and `page_leave`.
class WebCollectionRouteObserver extends RouteObserver<PageRoute<dynamic>> {
  final Map<String, int> _pageEntryTimestamps = {};

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPush(route, previousRoute);
    if (route is PageRoute) {
      _onPageEnter(route);
    }
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPop(route, previousRoute);
    if (route is PageRoute) {
      _onPageLeave(route);
    }
    if (previousRoute is PageRoute) {
      _onPageEnter(previousRoute);
    }
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
    if (oldRoute is PageRoute) {
      _onPageLeave(oldRoute);
    }
    if (newRoute is PageRoute) {
      _onPageEnter(newRoute);
    }
  }

  void _onPageEnter(PageRoute<dynamic> route) {
    final name = _getRouteName(route);
    if (name.isEmpty) return;

    _pageEntryTimestamps[name] = DateTime.now().millisecondsSinceEpoch;

    if (WebCollectionClient.isInitialized) {
      WebCollectionClient.instance.behavior('pv', props: {
        'path': name,
        'title': route.settings.name ?? name,
      });
    }
  }

  void _onPageLeave(PageRoute<dynamic> route) {
    final name = _getRouteName(route);
    if (name.isEmpty) return;

    final entryTs = _pageEntryTimestamps.remove(name);
    final stayTime = entryTs != null ? DateTime.now().millisecondsSinceEpoch - entryTs : 0;

    if (WebCollectionClient.isInitialized) {
      WebCollectionClient.instance.behavior('page_leave', props: {
        'path': name,
        'stayTime': stayTime,
      });
    }
  }

  String _getRouteName(PageRoute<dynamic> route) {
    return route.settings.name ?? route.runtimeType.toString();
  }
}
