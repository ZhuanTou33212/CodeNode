# 压缩卡与浏览器 UI 回归修复

此前压缩卡用例将旧主题的 2px 左边框作为通过条件，当前通用消息样式会将该装饰线清除。保留现有界面，改为检查压缩卡确实可见、只出现一次、摘要默认折叠且可展开/收起；旧历史从下一次模型请求中排除，交接摘要仍正确携带。

补充日间/夜间真实交互检查，两种主题的卡片结构一致，主题切换保留消息、会话 ID、输入草稿、模型显示及侧栏状态。

浏览器启动此前仅给出“Edge CDP 未就绪”，没有保存浏览器输出。现在默认由操作系统分配空闲调试端口，隐藏测试启动窗口，读取浏览器启动输出，区分可执行文件缺失、启动错误、进程提前退出和调试端口超时。HTTP 探测有单次超时与总启动期限，只有被测应用页面就绪才开始交互；测试临时配置目录清理前核验路径。

另一次回归复现了共享源码修改触发 Vite 热更新后画布被重置的情况。矢量用例默认改为独立静态构建快照及本机临时 HTTP 服务，不复用开发服务器，不受 HMR 干扰；`VECTOR_TEST_URL` 仍可显式指定外部测试页面。

此前超时日志不足以证明唯一根因是端口冲突；本次消除随机端口碰撞风险并补足故障诊断，没有将未定位的原因当作已证实结论。

## 验证结果

- 两项定向 UI 回归通过；真实 Edge 画布交互 65/65 检查通过。
- 完整显示套件 13/13 通过，日志 `out/ui-fix-display-final.log`。
- 静态快照改动后的完整显示套件再次 13/13 通过，日志 `out/ui-fix-display-stable.log`；真实 ASAR 压缩卡回归通过，日志 `out/ui-fix-final-packaged-compaction.log`。
- 主进程及脚本静态检查通过，日志 `out/ui-fix-checkjs-final.log`。
- 负向控制中，缺失浏览器 235 ms 内报告准确错误；用会立即退出的进程模拟启动失败，1015 ms 内报告提前退出原因。两项均正确返回非零退出码，结果 `out/ui-fix-browser-failure-controls.json`。

本次主要修改测试契约与启动可靠性，没有为通过测试关闭画布、压缩或异常检查。

## 固定目录交付

在确认旧版未运行后，由 `.stage-ui-regression-release/win-unpacked` 无备份原位替换 `E:\CodeNode\release\win-unpacked`。固定 EXE 自检 `ok=true`、退出码 0，`appPath` 指向原路径的 `resources/app.asar`；174 个打包文件与冻结源码匹配。

记录：`out/ui-fix-fixed-selftest.json`、`out/ui-fix-fixed-package-check.log`、`out/ui-fix-delivery-hashes.json`。ASAR SHA256 为 `207e5b3e090684e3db7797047574fe7f4299c9e2924ae4bf08d3ec800bc0bf98`。已与同时开发安全编辑功能的聊天协调交付窗口并保留其改动。
