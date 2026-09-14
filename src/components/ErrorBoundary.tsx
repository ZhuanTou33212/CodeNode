import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null; info: ErrorInfo | null };

/**
 * 顶层错误边界。
 *
 * React 在渲染 / 生命周期里遇到未捕获异常时会卸载整棵树；项目里此前没有任何
 * 边界，所以任何一处渲染报错都会让窗口变成一片空白、且不给任何提示
 * （例如 WorkbenchDock 的 Hook 顺序问题就是这样炸的）。
 * 这里把崩溃兜成一个可读的错误页，并保留错误信息便于反馈。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // 保留现场：DevTools 控制台与 logs/console.log 都能看到
    console.error('[CodeNode] 渲染崩溃:', error, info?.componentStack);
  }

  private retry = () => {
    this.setState({ error: null, info: null });
  };

  private reload = () => {
    window.location.reload();
  };

  private copy = () => {
    const { error, info } = this.state;
    const text = [
      `[CodeNode] ${error?.message || String(error)}`,
      '',
      error?.stack || '',
      '',
      '--- componentStack ---',
      info?.componentStack || '',
    ].join('\n');
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-card">
          <span className="crash-badge">渲染出错</span>
          <h1>界面遇到了一个错误</h1>
          <p className="crash-sub">
            已被错误边界拦下，所以没有变成无提示的白屏。可以先复制下面的信息用于反馈，再重新加载窗口。
          </p>
          <pre className="crash-stack">{(error.stack || String(error)).slice(0, 4000)}</pre>
          {info?.componentStack ? (
            <details className="crash-details">
              <summary>组件调用栈</summary>
              <pre className="crash-stack">{info.componentStack.slice(0, 4000)}</pre>
            </details>
          ) : null}
          <div className="crash-actions">
            <button type="button" className="crash-btn primary" onClick={this.reload}>
              重新加载窗口
            </button>
            <button type="button" className="crash-btn" onClick={this.retry}>
              尝试继续
            </button>
            <button type="button" className="crash-btn" onClick={this.copy}>
              复制错误信息
            </button>
          </div>
        </div>
      </div>
    );
  }
}
