# React Flow 1000 节点技术验证

该实验独立于现有零依赖画布，用于验证 React Flow 在 CodeNode 数据规模下的基础可用性。

```powershell
npm install
npm run build
npm run dev -- --host 127.0.0.1 --port 4174
```

打开 `http://127.0.0.1:4174/?nodes=1000`。页面会把测量结果写入顶部面板和 `window.__CODENODE_REACT_FLOW_BENCHMARK__`。

2026-07-14 在 Codex 内置浏览器的实测结果：

- React Flow 12.11.2、React 19.2.7、Vite 6.4.3；
- 1,000 节点、999 条边；
- `onlyRenderVisibleElements` 测量时实际 DOM 节点 110；
- 两帧初始化测量 66.30 ms；
- 30 次连续视口更新平均 14.04 ms/帧；
- 浏览器控制台错误 0。

这是技术选型基准，不等同于完整 Stage 1 编辑器。后续仍需使用真实 CodeNode 节点内容复测拖拽、选中、连线和持久化开销。
