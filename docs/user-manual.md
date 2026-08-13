<div align="center">

<p>
  <b>🇬🇧 English</b> ·
  <a href="user-manual.zh-CN.md">🇨🇳 中文</a>
</p>

# 📘 Web Collection User Manual

> A complete troubleshooting guide — from "a user reports an issue" to on-site recreation, root-cause localization, and fix verification.

[![Docs](https://img.shields.io/badge/docs-user--manual-en-blue)](user-manual.md) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

This guide is for front-end developers, QA, product, and operations staff who have integrated Web Collection. It explains how to start from "a user reports an issue", recreate the on-site scenario in the console, locate the cause, and verify the fix.

Production console 👉 [https://your-domain.com](https://your-domain.com)

## 📑 Table of Contents

- [🧰 1. Before You Start](#1-before-you-start)
- [🖥️ 2. Common Console Operations](#2-common-console-operations)
- [🔍 3. Standard Issue Localization Workflow](#3-standard-issue-localization-workflow)
- [⚡ 4. Performance Issue Localization](#4-performance-issue-localization)
- [📈 5. Product & Conversion Issue Localization](#5-product-conversion-issue-localization)
- [🗺️ 6. SourceMap & Source Localization](#6-sourcemap-source-localization)
- [🛡️ 7. Collection Governance](#7-collection-governance)
- [🧪 8. Complete Troubleshooting Example](#8-complete-troubleshooting-example)
- [❓ 9. FAQ](#9-faq)
- [✅ 10. Issue Handling Checklist](#10-issue-handling-checklist)

## 🧰 1. Before You Start

### 1.1 Confirm the SDK is properly integrated

```html
<script src="https://your-domain.com/sdk/web-collection-sdk.iife.js"></script>
<script>
  const eys = window.WebCollection.createEys({
    endpoint: 'https://your-domain.com/api/collect',
    appId: 'mall-web',
    release: '1.0.0'
  })
</script>
```

After a successful login, supplement the user information so that errors, behaviors, and replays can later be quickly retrieved by user:

```js
eys.setUser({
  id: currentUser.id,
  name: currentUser.name,
  phone: currentUser.phone
})
```

We recommend updating `release` on every release. Do not reuse the same `appId` across different environments; use `mall-web-dev`, `mall-web-test`, `mall-web-prod` to distinguish environments.

### 1.2 Verify data is reaching the platform

1. Open the monitored page and complete one page view, button click, and API request.
2. In the browser Network tab, confirm `/api/collect` returns success — it must not stay Pending for long, nor show CORS errors.
3. Enter "Behavior Analytics", select the corresponding app and the most recent time range.
4. If you can see page views, clicks, performance, or request events, basic collection is working.

If there is no data in behavior or tracking details, check in order:

- Whether the SDK file loaded successfully and `window.WebCollection` exists.
- Whether `endpoint` is the full `/api/collect` URL.
- Whether `appId` and `release` are filled in correctly.
- In "Collection Governance", whether the app is enabled, whether the event sample rate is greater than 0, and whether the trusted origins include the current site's Origin.
- Whether the page is blocked by an ad blocker, proxy, CSP, or browser privacy policy.

## 🖥️ 2. Common Console Operations

The app, version, time range, and keyword at the top of the page are global conditions that affect the data on the current page. When troubleshooting, we recommend narrowing the scope in this order:

1. Select the correct app.
2. Select the version the user was on when the issue occurred.
3. Narrow the time range to 10–30 minutes around when the issue happened.
4. Use the user ID, session ID, Trace ID, error keyword, or page path to continue locating.

Filters within a page keep only conditions specific to that feature, e.g. error status, URL/path, user info, and log level.

## 🔍 3. Standard Issue Localization Workflow

When a user reports an issue, first collect this minimum set of information:

- Time of occurrence, ideally precise to the minute.
- Page address and steps to reproduce.
- User ID; if there is no logged-in user, record the session ID.
- App version.
- The error message seen, exception screenshot, or failed API.

Then troubleshoot in the order: Overview → Error Monitoring → Session Replay → Distributed Tracing/Logs → Behavior Tracking → Fix Verification.

### 3.1 Identify the issue type from the Overview

Enter "Overview", select the app, version, and the time the issue occurred:

- **Rising error count**: prioritize "Error Monitoring".
- **Elevated P95 page-load time or declining page health**: go to "Performance Monitoring".
- **More affected users**: look for related errors, users, Traces, logs, and replays in Unified Activity.
- **Abnormal active sessions but no errors**: check "Behavior Tracking", "User Paths", and "Funnel Analysis".
- **High-priority issue alert**: click the alert to jump to the related issue, and prioritize checking the number of affected users and version scope.

Page health is calculated from a combination of Web Vitals and collected page-experience metrics. It is good for judging trends but does not replace single-metric diagnosis; after the score drops you still need to look at LCP, INP, CLS, blank-screen time, long tasks, slow APIs, and slow resources.

### 3.2 Confirm the specific error in Error Monitoring

After entering "Error Monitoring":

1. Filter by URL/path, user ID, username, phone, or error status.
2. In the "Error List", confirm the issue aggregation by error message, type, status, version, occurrence count, and source location.
3. Click "Details" to view the error message, stack, additional info, page, user, version, and first/most-recent occurrence time.
4. In "Error Events", view each actual occurrence and its source line/column.
5. Record the session ID, Trace ID, page, and occurrence time corresponding to the error, for continued correlation.

Direction for common errors:

| Error | Check first |
| --- | --- |
| `TypeError` / JS runtime error | Specific message, stack, source line/column, action before trigger |
| `UnhandledRejection` | Uncaught async calls, API responses, Promise error handling |
| `FetchError` | Request URL, network status, CORS, whether the API service is available |
| `ResourceError` | JS/CSS/image URLs, CDN, cache, and build artifacts |
| `SseError` | SSE URL, auth, connection-close status; a business-initiated disconnect is not necessarily a fault |
| `WebSocketError` | Connection URL, protocol, auth, close code, and network environment |

After the fix is released, click "Resolve" to mark the issue as resolved. If the same error fingerprint reappears in a later version, the platform can alert it as a regression.

### 3.3 Recreate the user session with Session Replay

Enter from "Play Session" in Overview or the "Session Replay" page:

1. Filter by URL/path, user ID, username, or phone.
2. Select the session matching the error time and page.
3. Click "Play" and observe the route changes, clicks, inputs, scrolls, and page changes before the error occurred.
4. Align the playback timeline with the error event, log time, and API request time.

When replay is empty, do not immediately judge that there were no user actions; first check:

- Whether the session only has an end record but no valid rrweb data.
- Whether the app's replay sample rate is greater than 0.
- Whether the SDK configured `replay: false`.
- Whether the issue occurred before replay started, in the gap between route segments, or after a single segment's max recording time.
- Whether sensitive areas used `.eys-block` or `.eys-ignore` to actively exclude them.
- Whether the replay buffer was compressed due to `replay_buffer_full` (the ring buffer was evicted by capacity / time window) — for long sessions or high-frequency operations you can appropriately increase `replayBufferSize` / `replayWindowMs`.
- Whether rrweb errored internally (`replay_recorder_error`) — browser incompatibility or a custom `replayOptions` caused recording to fail; see diagnostic events for details.
- When self-hosting the IIFE, whether rrweb loaded successfully: whether the script at `replayLibUrl` is reachable and exposes `window.rrweb`; with ESM the SDK loads it on demand automatically, no extra config needed.

> **Error-triggered upsampling**: When an error occurs on the page, the SDK automatically performs **error-triggered upsampling** on the replay — extending the retention window from the default 30 seconds to 60 seconds and raising it to full sampling, while tagging it with the `replay_error_triggered` marker. Therefore, error sessions carrying this marker usually have more complete replays than ordinary sessions; when troubleshooting, prioritize these sessions to recreate the on-site scenario.

Replay is for recreating operations and should not record sensitive content such as passwords, verification codes, ID numbers, or bank cards.

### 3.4 Locate API issues with Distributed Tracing

When there is a Trace ID in the error details or Unified Activity:

1. Enter "Distributed Tracing" and search for that Trace ID.
2. Open the trace detail and view Spans such as navigation, fetch, and xhr by time.
3. Focus on duration, request method, request URL, status code, and error count.
4. Determine whether the slow point is in page navigation, front-end waiting, network connection, or the back-end API.

For cross-origin APIs to generate a complete trace, you must explicitly configure trusted origins in the SDK:

```js
window.WebCollection.createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'mall-web',
  release: '1.0.0',
  traceOrigins: ['https://api.example.com']
})
```

The back-end service also needs to receive and continue propagating the standard `traceparent`; otherwise the platform can only see the front-end request Span and cannot automatically show the server-side internal calls.

### 3.5 Add context with Logs

Enter "Log Platform" and search by level, user, session, Trace ID, or keyword. We recommend that business code actively records structured logs at key steps:

```js
eys.log('info', 'order submitted', {
  orderId: 'SO10001',
  paymentType: 'wechat'
})
```

When you need to collect browser console logs:

```js
window.WebCollection.createEys({
  // other config omitted
  console: true,
  consoleLevels: ['info', 'warn', 'error']
})
```

Do not write passwords, Tokens, Cookies, Authorization, full phone numbers, or ID numbers into logs. In production, prefer active structured logging; do not collect all `console.log` indiscriminately.

### 3.6 Confirm user actions with Behavior Tracking

"Behavior Tracking" shows page views, page leaves, route changes, clicks, scrolls, exposures, and custom events. Buttons should provide readable names:

```html
<button data-track data-track-name="submit order">submit order</button>
```

For business-critical actions use active tracking; event names should be stable and semantically clear:

```js
eys.track('checkout_submit', {
  orderId: 'SO10001',
  skuCount: 3
})
```

Do not use names like "click1" or "event2", and do not concatenate high-cardinality fields such as order numbers or user IDs into the event name; put them in attributes.

## ⚡ 4. Performance Issue Localization

Enter "Performance Monitoring"; look at Web Vitals first, then slow APIs, slow resources, and performance events.

| Metric | Meaning | Common improvement direction |
| --- | --- | --- |
| LCP | Largest Contentful Paint | Optimize first-screen images, critical CSS, APIs, and server response |
| INP | Interaction to Next Paint | Split long tasks, reduce synchronous computation, optimize event handlers |
| CLS | Cumulative Layout Shift | Reserve dimensions for images/ads; avoid async-inserted content pushing the layout |
| FCP | First Contentful Paint | Reduce blocking resources and first-screen JS; optimize caching |
| TTFB | Time to First Byte | Check network, CDN, gateway, and server-side processing |
| Blank-screen time | Time until the first valid content appears on the home page | Check JS initialization, routing, first-screen APIs, and render blocking |
| First-screen completion time | Time when key first-screen content is usable | Optimize key APIs and component load order |
| Long task / TBT | Main thread occupied for a long time | Split computation, defer non-critical logic, use a Worker |
| Slow API rate | Proportion of requests exceeding the threshold | Check trace, API P75, error rate, and request body size |
| Resource failure rate | Proportion of static resources failing to load | Check CDN, version path, cache, and cross-origin |

Recommended troubleshooting method:

1. Filter the problem page by page path.
2. Determine whether all users are slow, or only specific versions, users, or network environments.
3. Find the object with high P75 in slow APIs and slow resources.
4. Open the associated Trace and confirm the specific slow Span.
5. Compare versions before and after the release; if the new version is noticeably worse, prioritize checking the release diff.

## 📈 5. Product & Conversion Issue Localization

"Product Analytics" includes event analysis, user sessions, user paths, funnel analysis, version comparison, and custom dashboards.

### 5.1 Event Analysis

Select an already-collected event and view trends by event count, user count, or session count, and split by version, page, browser, device, or event attribute. Filter conditions support equals, belongs-to-set, and attribute-is-set. Commonly used analyses can be saved and added to a custom dashboard.

### 5.2 User Paths

After setting the start page, end page, and max depth, an interactive path graph is generated. Click a path node to view its source, destination, user count, and session count. When an abnormal path is found, combine behavior events and replay to confirm whether the user left actively, a route errored, or the page crashed.

### 5.3 Funnel Analysis

Before creating a funnel, ensure each step has a stable active tracking event. For example:

```js
eys.track('view_product')
eys.track('add_cart')
eys.track('submit_order')
eys.track('pay_success')
```

In "Funnel Analysis", fill in the name, app, and at least two steps, in the order they occur; each step can add event attribute filters. The funnel only counts behaviors completed in order within the same session. After clicking "Analyze", view:

- The number of people entering each step and the conversion rate.
- The number of users lost between steps.
- The last step reached by lost users.
- Errors and replays associated with lost sessions.
- Trends across different dimensions and dates.

If the funnel has no data, first confirm in "Behavior Analytics" details that the step names are exactly consistent. Event names are case-sensitive; inconsistent naming or unreported steps will result in empty results.

### 5.4 Version Comparison

Used to compare event counts, user counts, error counts, and average LCP across versions. When errors increase or performance drops after a release, you can quickly determine whether it is related to the new version.

## 🗺️ 6. SourceMap & Source Localization

After production code is minified, error stacks usually only point to the bundled file. You should upload the SourceMap that exactly matches the current `appId` and `release` after the business build completes:

```bash
pnpm sourcemaps:upload -- --dir dist --app-id mall-web --release 1.0.0 \
  --endpoint https://your-domain.com
```

After uploading, re-view the error details; the platform will resolve the source file, line, and column based on `release + bundled file name`.

When resolution fails, check:

- Whether the SDK's `release` matches the upload parameter.
- Whether the bundled file name in the SourceMap matches the error stack.
- Whether the build actually generated `.map` files.
- Whether the released artifacts and SourceMap come from the same build.

SourceMaps are uploaded only to the monitoring service and should not be publicly published alongside production static assets.

## 🛡️ 7. Collection Governance

"Collection Governance" is used to manage apps and collection costs:

- Add or edit apps, owners, and platform types.
- Set event sample rate and replay sample rate.
- Configure trusted origins, disabled event types, and disabled event names.
- Manage release versions and collection keys.
- Set data retention period, alert threshold, and alert cooldown.
- Export events, errors, and replay CSV.
- Run expired-data cleanup.

Sampling recommendations:

- Pilot or low-traffic apps can start with 100% event sampling.
- Replay data volume is large; in production, gradually lower the sample rate based on traffic.
- When troubleshooting urgent issues, temporarily raise the sample rate, then restore it after the issue is resolved.
- To stop ingestion immediately, set both event and replay sample rates to 0.
- Lowering the global `sampleRate` **does not lose errors**: error events and their associated request traces are forcibly retained by default (priority retention); even at a very low sample rate, Error Monitoring and tracing can still find the corresponding data; only when `errorSampleRate` is explicitly configured will errors be deterministically sub-sampled.

**Privacy protection (minimal collection by default)**: The SDK defaults to the `balanced` profile, which already automatically applies an irreversible hash to `userPhone`, value-level masking to email / ID card / bank card / JWT, drops sensitive request headers such as `Authorization` / `Cookie`, and strips `token` / `code` / `phone` and other parameters from URLs. Do not put sensitive information such as passwords, Tokens, or raw phone numbers into `baggage` or tracking attributes; in strict-compliance scenarios, set `privacy.mode` to `strict` (drop the entire query from URLs, collect only indexes and counts for dropdowns). When the browser emits a **GPC** or **DNT** signal, replay and request-body sampling that have not been explicitly authorized are automatically downgraded and disabled — if you still want to collect replay when the user has DNT enabled, explicitly authorize `replay` in `privacy.consentCategories`.

After resetting the collection key, the old key becomes invalid; you must promptly update the business SDK's `collectKey`, otherwise new collection requests will be rejected.

## 🧪 8. Complete Troubleshooting Example

### Scenario: A user reports "the page keeps spinning after submitting the order"

1. Confirm with the user the time, user ID, order number, page address, and app version.
2. In "Overview", select the app, version, and time, and confirm whether errors or elevated P95 occurred at the same time.
3. In "Error Monitoring", filter by user ID and page path, and find `FetchError: Failed to fetch`.
4. Open the error details and record the Trace ID, session ID, request page, and occurrence time.
5. Click the associated replay and confirm that the loading state never ended after the user clicked "Submit Order".
6. In "Distributed Tracing", search the Trace ID and find the order API has no successful status code and its duration hit the timeout threshold.
7. In "Log Platform", query by Trace ID and find the order number exists in pre-submit logs but there is no success-callback log.
8. In "Behavior Tracking", confirm the user clicked "Submit Order" only once, ruling out duplicate clicks.
9. Combine browser and server-side logs to check the gateway, CORS, timeout, or service exception, and fix the loading-close logic after the request fails.
10. Release a new version and upload the corresponding SourceMap, then repeat the test operation.
11. Confirm the new version's API Span succeeds, the error no longer appears, and the loading ends normally in replay, then mark the issue as "Resolved".

### Expected root-cause conclusion

```text
Issue: Page keeps loading after submitting the order
Impact: Version 1.0.0, 3 users, 5 occurrences
Time: 2026-07-22 15:30—15:45
Page: /checkout
Error: FetchError: Failed to fetch
Trace: traceId=...
Root cause: Order API CORS preflight failed; front-end failure branch did not close loading
Fix: Add CORS config and close loading in finally
Verification: Version 1.0.1 passed event, trace, and replay verification
```

## ❓ 9. FAQ

### Console shows a total but the table has no data

First click refresh and confirm the page number returns to the first page, then shorten the filter conditions. If it is still abnormal, view the corresponding list API response in the browser Network and confirm whether `items`, `page`, `pageSize`, and `total` match.

### Affected users stays at 0

Confirm `setUser` was called after a successful login. Anonymous sessions can be used for replay and event correlation, but cannot stably represent the real user count.

### Log Platform has no data

Call `eys.log()` actively, or enable `console: true` and configure `consoleLevels` during initialization. After changing the config, redeploy the business app, then generate a test log.

### Behavior Analytics query by URL/path does not match

Prefer filling in the page path, e.g. `/pages/login/login`. After querying, check whether the global app, version, time, and keyword still have restrictive conditions.

### Replay list has records but playback is empty

The record may have no valid rrweb events. Check the replay sample rate, SDK replay config, recording duration, and privacy-exclusion selectors, and verify with a new test session.

### Funnel Analysis returns empty data

In Behavior Analytics details, confirm each step is reported under the same `appId`, and verify the event name, occurrence order, time range, and user/session identifiers.

### `/api/collect` shows a CORS error

In the app config in "Collection Governance", add the full Origin of the business page, e.g. `https://shop.example.com`, without a path. Confirm the preflight request allows the required headers and methods.

### `/api/collect` stays Pending for a long time

Check the request body size, replay batch, network proxy, and Worker logs. First disable replay or reduce the replay batch to verify whether it is related to large requests, but do not treat the temporary disable as the final fix.

### How to observe the SDK's own transport and replay health

Monitor non-sensitive health events via the `onDiagnostic` callback at initialization, for monitoring collection cost and anomalies without appearing in business data:

```js
window.WebCollection.createEys({
  endpoint: 'https://your-domain.com/api/collect',
  appId: 'mall-web',
  release: '1.0.0',
  onDiagnostic: (e) => {
    // e.type contains no business PII and can be reported to your own monitoring
    if (e.type === 'queue_full') console.warn('local queue overflow', e)
    if (e.type === 'replay_buffer_full') console.warn('replay window compressed', e)
    if (e.type === 'replay_recorder_error') console.warn('rrweb recording error', e)
  }
})
```

Common types: transport-side `queue_full` (local queue overflow), `dropped_by_sampling` (dropped by sampling), `beacon_rejected` / `beacon_oversize` (exit-channel failures), `next_session_recovered` (recovered next session); replay-side `replay_buffer_full`, `replay_worker_unavailable` (compression fallback), `replay_compressed` (compressed byte count), `replay_error_triggered` (error-session marker), `replay_recorder_error` (internal recording error), `replay_quality` (buffer / dropped frames / page count and other quality metrics).

## ✅ 10. Issue Handling Checklist

- [ ] Confirmed app, version, occurrence time, page, and user.
- [ ] Determined in Overview whether the issue is an error, performance, or behavior/conversion issue.
- [ ] Viewed the specific error message, stack, and source line/column.
- [ ] Checked the associated session replay.
- [ ] Checked the Trace and failed/slow requests.
- [ ] Checked structured logs and user behavior.
- [ ] Confirmed the SourceMap matches the release version.
- [ ] Recorded the impact scope, root cause, fix content, and verification result.
- [ ] After the new version passes verification, marked the issue resolved.
