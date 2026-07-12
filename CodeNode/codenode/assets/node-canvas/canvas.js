(() => {
  const canvas = document.querySelector('#canvas');
  const nodesEl = document.querySelector('#nodes');
  const edgesEl = document.querySelector('#edges');
  const emptyState = document.querySelector('#empty-state');
  const inspector = { hint: document.querySelector('#selection-hint'), name: document.querySelector('#node-name'), prompt: document.querySelector('#node-prompt'), make: document.querySelector('#make-node'), status: document.querySelector('#node-status'), validation: document.querySelector('#validation-message') };
  const state = { nodes: [], edges: [], selected: null, scale: 1, offset: { x: 0, y: 0 }, connecting: null, panning: null };
  let buildMode = 'node';
  state.nodes = [];
  state.edges = [];

  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function port(node, kind, id) { return (kind === 'input' ? node.inputs : node.outputs).find(item => item.id === id); }
  function screenPoint(x, y) { return { x: x * state.scale + state.offset.x, y: y * state.scale + state.offset.y }; }
  function render() {
    nodesEl.innerHTML = '';
    state.nodes.forEach(node => {
      const el = document.createElement('article'); el.className = `node ${state.selected === node.id ? 'selected' : ''}`; el.dataset.id = node.id; el.style.transform = `translate(${node.x}px, ${node.y}px)`;
      const draftEditor = node.status === '草稿' ? `<div class="node-meta"><input class="inline-editor inline-name" value="${escapeAttr(node.name)}" aria-label="节点名称"><textarea class="inline-editor inline-prompt" aria-label="制作要求" placeholder="填写制作要求">${escapeHtml(node.prompt)}</textarea></div>` : `<div class="node-meta">${escapeHtml(node.category)} · ${escapeHtml(node.status)}</div>`;
      el.innerHTML = `<div class="node-header">${escapeHtml(node.name)}</div>${draftEditor}<div class="ports inputs">${node.inputs.map(p => portHtml('input', p)).join('')}</div><div class="ports outputs">${node.outputs.map(p => portHtml('output', p)).join('')}</div>`;
      el.querySelector('.inline-name')?.addEventListener('input', event => { node.name = event.target.value || '空白节点'; el.querySelector('.node-header').textContent = node.name; inspector.name.value = node.name; });
      el.querySelector('.inline-prompt')?.addEventListener('input', event => { node.prompt = event.target.value; inspector.prompt.value = node.prompt; });
      el.querySelectorAll('.inline-editor').forEach(input => input.addEventListener('pointerdown', event => event.stopPropagation()));
      el.querySelectorAll('.inline-editor').forEach(input => input.addEventListener('keydown', event => event.stopPropagation()));
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
  function handlePoint(nodeId, kind, portId) { const node = nodeById(nodeId); if (!node) return null; const index = (kind === 'input' ? node.inputs : node.outputs).findIndex(p => p.id === portId); return { x: node.x + (kind === 'input' ? 0 : 210), y: node.y + 82 + index * 22 }; }
  function updateInspector() { const node = nodeById(state.selected); inspector.hint.textContent = node ? `节点编号：${node.id}` : '选择一个节点查看详情。'; inspector.name.value = node?.name || ''; inspector.prompt.value = node?.prompt || ''; inspector.name.disabled = inspector.prompt.disabled = inspector.make.disabled = !node; inspector.status.textContent = `状态：${node?.status || '—'}`; }
  document.querySelector('#add-node').addEventListener('click', () => { const id = `node-${Date.now()}`; state.nodes.push({ id, name: '空白节点', category: '自定义', prompt: '', status: '草稿', x: 300, y: 160, inputs: [], outputs: [] }); select(id); });
  inspector.name.addEventListener('input', () => { const node = nodeById(state.selected); if (node) { node.name = inspector.name.value || '空白节点'; render(); } });
  inspector.prompt.addEventListener('input', () => { const node = nodeById(state.selected); if (node) node.prompt = inspector.prompt.value; });
  [inspector.name, inspector.prompt].forEach(input => input.addEventListener('keydown', event => event.stopPropagation()));
  function buildSelected() { const node = nodeById(state.selected); if (!node) { inspector.validation.textContent = '请先选择一个空白节点。'; return; } const text = node.prompt || ''; if (buildMode === 'program') { node.category = '程序'; node.status = '程序草稿'; node.inputs = []; node.outputs = []; inspector.validation.textContent = '已生成程序草稿，可继续补充制作要求。'; render(); return; } if (/相加|加法|add/i.test(text)) { node.name = node.name === '空白节点' ? '整数相加' : node.name; node.category = '转换'; node.inputs = [{ id: 'left', name: '左值', dataType: 'int' }, { id: 'right', name: '右值', dataType: 'int' }]; node.outputs = [{ id: 'result', name: '结果', dataType: 'int' }]; } else { node.category = '自定义'; node.inputs = [{ id: 'input', name: '输入值', dataType: 'int' }]; node.outputs = [{ id: 'output', name: '输出值', dataType: 'int' }]; } node.status = '已制作'; inspector.validation.textContent = '节点已制作，可以连接兼容端口。'; render(); }
  inspector.make.addEventListener('click', buildSelected);
  document.querySelector('#board-build').addEventListener('click', () => { const switcher = document.querySelector('#build-switch'); switcher.hidden = !switcher.hidden; });
  document.querySelectorAll('.build-mode').forEach(button => button.addEventListener('click', () => { buildMode = button.dataset.mode; document.querySelectorAll('.build-mode').forEach(item => item.classList.toggle('active', item === button)); buildSelected(); }));
  document.querySelector('#clear-canvas').addEventListener('click', () => { state.nodes = []; state.edges = []; state.selected = null; render(); });
  document.querySelector('#fit-view').addEventListener('click', () => { state.scale = 1; state.offset = { x: 0, y: 0 }; render(); });
  canvas.addEventListener('wheel', event => { event.preventDefault(); state.scale = Math.min(1.8, Math.max(.55, state.scale * (event.deltaY < 0 ? 1.08 : .92))); render(); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (event.button !== 1 && !event.shiftKey && event.target !== canvas) return; state.panning = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y }; canvas.classList.add('is-panning'); });
  window.addEventListener('pointermove', event => { if (!state.panning) return; state.offset.x = state.panning.ox + event.clientX - state.panning.x; state.offset.y = state.panning.oy + event.clientY - state.panning.y; render(); });
  window.addEventListener('pointerup', () => { state.panning = null; canvas.classList.remove('is-panning'); });
  window.addEventListener('keydown', event => { if (event.key === 'Delete' && state.selected) { state.nodes = state.nodes.filter(n => n.id !== state.selected); state.edges = state.edges.filter(e => e.source[0] !== state.selected && e.target[0] !== state.selected); state.selected = null; render(); } });
  render();
})();
