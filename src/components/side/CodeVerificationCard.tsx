import type { CodeVerificationReport } from '../../types';
const labels: Record<string,string> = {running:'校验中',passed:'所选局部校验通过',partial:'仅部分校验完成',failed:'校验失败',stale:'结果已失效',unknown:'无法确认',not_run:'未执行',not_supported:'不支持此语法检查',disabled:'已关闭',cancelled:'已取消',timed_out:'超时'};
const kinds: Record<string,string> = {syntax:'语法',lint:'lint',test:'测试'};
export default function CodeVerificationCard({report,compact=false}:{report:CodeVerificationReport;compact?:boolean}) {
  if (compact) return <div className="file-change-verification code-verification" role="status" data-status={report.status}>校验：{labels[report.status === 'passed' && !report.verified ? 'unknown' : report.status] || '无法确认'}</div>;
  return <section className="code-verification" aria-label="修改后校验" role="status">
    <strong>校验记录 · {labels[report.status === 'passed' && !report.verified ? 'unknown' : report.status] || '无法确认'}</strong>
    <div>{report.files.join('、')}</div>
    {report.reason && <div>{report.reason}</div>}
    {report.scope && <small>{report.scope}</small>}
    {report.checkedAt && <div>记录时间：{new Date(report.checkedAt).toLocaleString()}</div>}
    <details><summary>查看检查结果</summary>{report.checks.map((check,index)=><div className="code-verification-check" key={index}>
      <b>{kinds[check.kind] || check.kind} · {check.status === 'passed' ? '通过' : labels[check.status] || '无法确认'}</b>
      {check.path && <div>{check.path}</div>}{check.command && <code>{check.command}</code>}
      {check.exitCode != null && <div>退出码 {check.exitCode}</div>}
      {check.reason && <div>{check.reason}</div>}{check.output && <pre>{check.output}</pre>}{check.truncated && <small>输出已截断</small>}
    </div>)}</details>
  </section>;
}
