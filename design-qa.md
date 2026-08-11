# Design QA

- Reference: provided performance-page screenshot with duplicated filters and an incorrect 1789 date.
- Implementation: global filters remain in the top bar; the page only renders URL/path.
- Browser check: selecting the last 24 hours produces a 2026 timestamp range and no page date picker.
- Build check: passed.

final result: passed

## Table Tooltip Row Anchoring — 2026-08-11

- Reference: 用户提供的告警记录截图，问题状态为 Tooltip 脱离悬浮行并显示在表格顶部。
- Implementation: Tooltip 继续受所属表格宽度限制，定位锚点保持为当前悬浮单元格；默认显示在行上方，空间不足时仅翻转到行下方。
- Browser viewport: 1561 × 511，与参考截图一致。
- Top placement measurement: Tooltip bottom 216px，当前行 top 224.33px，间距 8.33px，无重叠。
- Bottom placement measurement: 当前行 bottom 89.33px，Tooltip top 97px，间距 7.67px，无重叠。
- Width measurement: Tooltip 1296px，所属表格 1296px；边框取整误差不超过 2px。
- Interaction check: 上方定位与下方自动翻转均通过，超长内容可滚动，未遮挡当前悬浮行。
- Scrollbar check: 单行 Tooltip 的 clientHeight 与 scrollHeight 均为 28px，不再产生纵向滚动条；Popper 箭头节点已关闭，多行滚动条的系统上下按钮通过 WebKit 样式隐藏。
- Console check: 未发现本次修改引入的新错误；页面仍有一条既有 Vue runtime directive 警告，与 Tooltip 无关。
- Remaining P0/P1/P2 issues: none.

final result: passed
