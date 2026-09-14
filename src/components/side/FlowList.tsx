/** 数据流条目小列表（节点属性 / 检查器共用） */
export default function FlowList({ title, items }: { title: string; items: { kind: string; label: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="inspector-field">
      <label>
        {title}（{items.length} 项）
      </label>
      <ul className="flow-list">
        {items.map((it, i) => (
          <li key={i}>
            <span className="flow-kind">{it.kind}</span>
            <span className="flow-label">{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
