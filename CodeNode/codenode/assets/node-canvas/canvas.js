(() => {
  const canvas = document.querySelector('#canvas');
  const nodesEl = document.querySelector('#nodes');
  const edgesEl = document.querySelector('#edges');
  const emptyState = document.querySelector('#empty-state');
  const inspector = { hint: document.querySelector('#selection-hint'), name: document.querySelector('#node-name'), prompt: document.querySelector('#node-prompt'), language: document.querySelector('#node-language'), code: document.querySelector('#node-code'), make: document.querySelector('#make-node'), status: document.querySelector('#node-status'), validation: document.querySelector('#validation-message') };
  const state = { nodes: [], edges: [], selected: null, scale: 1, offset: { x: 0, y: 0 }, connecting: null, panning: null };
  let buildMode = 'node';
  let language = 'java';
  state.nodes = [];
  state.edges = [];

  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function port(node, kind, id) { return (kind === 'input' ? node.inputs : node.outputs).find(item => item.id === id); }
  function screenPoint(x, y) { return { x: x * state.scale + state.offset.x, y: y * state.scale + state.offset.y }; }
  function render() {
    nodesEl.innerHTML = '';
    state.nodes.forEach(node => {
      const el = document.createElement('article'); el.className = `node ${state.selected === node.id ? 'selected' : ''}`; el.dataset.id = node.id; el.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const draftEditor = node.status === '草稿' ? `<div class="node-meta"><input class="inline-editor inline-name" value="${escapeAttr(node.name)}" aria-label="节点名称"><textarea class="inline-editor inline-prompt" aria-label="制作要求" placeholder="填写制作要求">${escapeHtml(node.prompt)}</textarea></div>` : `<div class="node-meta">${escapeHtml(node.category)} · ${escapeHtml(node.status)} · ${languageLabel(node.language)}</div>`;
      el.innerHTML = `<div class="node-header">${escapeHtml(node.name)}</div>${draftEditor}<div class="ports inputs">${node.inputs.map(p => portHtml('input', p)).join('')}</div><div class="ports outputs">${node.outputs.map(p => portHtml('output', p)).join('')}</div>`;
      el.querySelector('.inline-name')?.addEventListener('input', event => { node.name = event.target.value || '空白节点'; el.querySelector('.node-header').textContent = node.name; inspector.name.value = node.name; });
      el.querySelector('.inline-prompt')?.addEventListener('input', event => { node.prompt = event.target.value; inspector.prompt.value = node.prompt; });
      el.querySelectorAll('.inline-editor').forEach(input => input.addEventListener('pointerdown', event => event.stopPropagation()));
      el.querySelectorAll('.inline-editor').forEach(input => input.addEventListener('keydown', event => event.stopPropagation()));
      el.querySelectorAll('.inline-editor').forEach(input => input.addEventListener('click', event => event.stopPropagation()));
      el.addEventListener('pointerdown', event => startNodeDrag(event, node));
      el.addEventListener('click', () => select(node.id)); nodesEl.appendChild(el);
    });
    nodesEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.scale})`;
    edgesEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.scale})`;
    drawEdges(); emptyState.hidden = state.nodes.length > 0; updateInspector();
  }
  function portHtml(kind, p) { const direction = kind === 'input' ? '输入' : '输出'; return `<div class="port ${kind}" data-port="${kind}:${p.id}"><span>${direction}：${escapeHtml(p.name)} · 整数</span><i class="handle" data-kind="${kind}" data-port-id="${p.id}"></i></div>`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
  function languageLabel(value) { return value === 'powershell' ? 'PowerShell' : 'Java'; }
  function generatedCode(node) { if (node.language === 'powershell') return `param([int]$左值, [int]$右值)\n$result = $左值 + $右值\n$result`; return `public static int 执行(int 左值, int 右值) {\n    return 左值 + 右值;\n}`; }
  function select(id) { state.selected = id; render(); }
  function startNodeDrag(event, node) {
    if (event.target.closest('.handle')) { startConnection(event, node); return; }
    if (!event.target.closest('.node-header')) return;
    event.stopPropagation(); const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y }; select(node.id);
    const move = e => { node.x = start.nodeX + (e.clientX - start.x) / state.scale; node.y = start.nodeY + (e.clientY - start.y) / state.scale; render(); };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop);
  }
  function startConnection(event, node) {
    const handle = event.target; const kind = handle.dataset.kind; if (kind !== 'output') return;
    state.connecting = { source: [node.id, handle.dataset.portId] }; event.stopPropagation();
    const finish = e => { const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.handle'); if (target?.dataset.kind === 'input') connect(target.dataset.portId, target.closest('.node').dataset.id); state.connecting = null; window.removeEventListener('pointerup', finish); };
    window.addEventListener('pointerup', finish);
  }
  function connect(targetPort, targetNodeId) {
    const sourceNode = nodeById(state.connecting.source[0]); const sourcePort = port(sourceNode, 'output', state.connecting.source[1]); const targetNode = nodeById(targetNodeId); const target = port(targetNode, 'input', targetPort);
    if (!target || target.dataType !== sourcePort.dataType) { inspector.validation.textContent = '连接被拒绝：端口类型不兼容。'; return; }
    state.edges = state.edges.filter(edge => !(edge.target[0] === targetNodeId && edge.target[1] === target.id)); state.edges.push({ id: `e${Date.now()}`, source: state.connecting.source, target: [targetNodeId, target.id], dataType: sourcePort.dataType }); render();
  }
  function drawEdges() {
    edgesEl.innerHTML = ''; state.edges.forEach(edge => { const a = handlePoint(edge.source[0], 'output', edge.source[1]); const b = handlePoint(edge.target[0], 'input', edge.target[1]); if (!a || !b) return; const bend = Math.max(40, Math.abs(b.x - a.x) * .45); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`); path.setAttribute('class', 'edge'); edgesEl.appendChild(path); });
  }
  function handlePoint(nodeId, kind, portId) { const handle = nodesEl.querySelector(`.node[data-id="${nodeId}"] .handle[data-kind="${kind}"][data-port-id="${portId}"]`); if (!handle) return null; const rect = handle.getBoundingClientRect(); const canvasRect = canvas.getBoundingClientRect(); return { x: (rect.left + rect.width / 2 - canvasRect.left - state.offset.x) / state.scale, y: (rect.top + rect.height / 2 - canvasRect.top - state.offset.y) / state.scale }; }
  function updateInspector() { const node = nodeById(state.selected); inspector.hint.textContent = node ? `节点编号：${node.id}` : '选择一个节点查看详情。'; inspector.name.value = node?.name || ''; inspector.prompt.value = node?.prompt || ''; inspector.name.disabled = inspector.prompt.disabled = inspector.make.disabled = !node; inspector.status.textContent = `状态：${node?.status || '—'}`; inspector.language.textContent = `语言：${languageLabel(node?.language || language)}`; inspector.code.value = node?.code || ''; inspector.code.disabled = !node; }
  document.querySelector('#add-node').addEventListener('click', () => { const id = `node-${Date.now()}`; state.nodes.push({ id, name: '空白节点', category: '自定义', prompt: '', language, code: '', status: '草稿', x: 300, y: 160, inputs: [], outputs: [] }); select(id); });
  inspector.name.addEventListener('input', () => { const node = nodeById(state.selected); if (node) { node.name = inspector.name.value || '空白节点'; const card = nodesEl.querySelector(`[data-id="${node.id}"] .node-header`); if (card) card.textContent = node.name; } });
  inspector.prompt.addEventListener('input', () => { const node = nodeById(state.selected); if (node) node.prompt = inspector.prompt.value; });
  [inspector.name, inspector.prompt].forEach(input => input.addEventListener('keydown', event => event.stopPropagation()));
  function programSource(node) { if (node.language === 'powershell') return `param([int]$左值 = 3, [int]$右值 = 4)\n$result = $左值 + $右值\nWrite-Output $result`; return `public class ${node.name.replace(/[^A-Za-z0-9]/g, '') || 'CodeNodeProgram'} {\n    public static void main(String[] args) {\n        int 左值 = 3;\n        int 右值 = 4;\n        System.out.println(左值 + 右值);\n    }\n}`; }
  function downloadFile(fileName, content, type) { const blob = new Blob([content], { type }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = fileName; link.click(); URL.revokeObjectURL(link.href); }
  function buildSelected(mode) { const node = nodeById(state.selected); if (!node) { inspector.validation.textContent = '请先选择一个空白节点。'; return; } node.language = language; const text = node.prompt || ''; if (mode === 'program') { node.category = '程序'; node.status = '程序代码'; node.inputs = []; node.outputs = []; node.code = programSource(node); const extension = language === 'powershell' ? 'ps1' : 'java'; downloadFile(`${node.name || 'CodeNode程序'}.${extension}`, node.code, 'text/plain;charset=utf-8'); inspector.validation.textContent = `已下载 ${languageLabel(language)} 可执行程序，请返回对话框继续使用。`; render(); return; } if (/相加|加法|add/i.test(text)) { node.name = node.name === '空白节点' ? '整数相加' : node.name; node.category = '转换'; node.inputs = [{ id: 'left', name: '左值', dataType: 'int' }, { id: 'right', name: '右值', dataType: 'int' }]; node.outputs = [{ id: 'result', name: '结果', dataType: 'int' }]; } else { node.category = '自定义'; node.inputs = [{ id: 'input', name: '输入值', dataType: 'int' }]; node.outputs = [{ id: 'output', name: '输出值', dataType: 'int' }]; } node.status = '代码节点'; node.code = generatedCode(node); downloadFile(`${node.name || 'CodeNode节点'}.md`, `# ${node.name}\n\n- 语言：${languageLabel(language)}\n- 类型：${node.category}\n- 制作要求：${node.prompt || '未填写'}\n\n## 代码\n\n\`\`\`${language === 'powershell' ? 'powershell' : 'java'}\n${node.code}\n\`\`\`\n`, 'text/markdown;charset=utf-8'); inspector.validation.textContent = '节点 Markdown 已下载，当前节点已具备代码功能。'; render(); }
  document.querySelector('#build-select').addEventListener('change', event => { const mode = event.target.value; if (mode) buildSelected(mode); event.target.value = ''; });
  document.querySelector('#language-select').addEventListener('change', event => { language = event.target.value; const node = nodeById(state.selected); if (node?.status === '草稿') node.language = language; updateInspector(); render(); });
  document.querySelector('#clear-canvas').addEventListener('click', () => { state.nodes = []; state.edges = []; state.selected = null; render(); });
  document.querySelector('#fit-view').addEventListener('click', () => { state.scale = 1; state.offset = { x: 0, y: 0 }; render(); });
  canvas.addEventListener('wheel', event => { event.preventDefault(); state.scale = Math.min(1.8, Math.max(.55, state.scale * (event.deltaY < 0 ? 1.08 : .92))); render(); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (event.button !== 1 && !event.shiftKey && event.target !== canvas) return; state.panning = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y }; canvas.classList.add('is-panning'); });
  window.addEventListener('pointermove', event => { if (!state.panning) return; state.offset.x = state.panning.ox + event.clientX - state.panning.x; state.offset.y = state.panning.oy + event.clientY - state.panning.y; render(); });
  window.addEventListener('pointerup', () => { state.panning = null; canvas.classList.remove('is-panning'); });
  window.addEventListener('keydown', event => { if (event.key === 'Delete' && state.selected) { state.nodes = state.nodes.filter(n => n.id !== state.selected); state.edges = state.edges.filter(e => e.source[0] !== state.selected && e.target[0] !== state.selected); state.selected = null; render(); } });
  render();
})();
