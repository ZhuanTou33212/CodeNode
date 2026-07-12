(() => {
  const canvas = document.querySelector('#canvas');
  const nodesEl = document.querySelector('#nodes');
  const edgesEl = document.querySelector('#edges');
  const emptyState = document.querySelector('#empty-state');
  const inspector = { hint: document.querySelector('#selection-hint'), name: document.querySelector('#node-name'), prompt: document.querySelector('#node-prompt'), status: document.querySelector('#node-status'), validation: document.querySelector('#validation-message') };
  const state = { nodes: [], edges: [], selected: null, scale: 1, offset: { x: 0, y: 0 }, connecting: null, panning: null };
  const sample = [
    { id: 'left', name: 'LeftInput', category: 'input', prompt: '提供左侧整数', status: 'ready', x: 90, y: 160, inputs: [], outputs: [{ id: 'value', name: 'value', dataType: 'int' }] },
    { id: 'right', name: 'RightInput', category: 'input', prompt: '提供右侧整数', status: 'ready', x: 90, y: 360, inputs: [], outputs: [{ id: 'value', name: 'value', dataType: 'int' }] },
    { id: 'add', name: 'AddIntegers', category: 'transform', prompt: '将两个整数相加并输出结果', status: 'ready', x: 450, y: 250, inputs: [{ id: 'left', name: 'left', dataType: 'int' }, { id: 'right', name: 'right', dataType: 'int' }], outputs: [{ id: 'result', name: 'result', dataType: 'int' }] }
  ];
  state.nodes = sample;
  state.edges = [{ id: 'e1', source: ['left', 'value'], target: ['add', 'left'], dataType: 'int' }, { id: 'e2', source: ['right', 'value'], target: ['add', 'right'], dataType: 'int' }];

  function nodeById(id) { return state.nodes.find(node => node.id === id); }
  function port(node, kind, id) { return (kind === 'input' ? node.inputs : node.outputs).find(item => item.id === id); }
  function screenPoint(x, y) { return { x: x * state.scale + state.offset.x, y: y * state.scale + state.offset.y }; }
  function render() {
    nodesEl.innerHTML = '';
    state.nodes.forEach(node => {
      const el = document.createElement('article'); el.className = `node ${state.selected === node.id ? 'selected' : ''}`; el.dataset.id = node.id; el.style.transform = `translate(${node.x}px, ${node.y}px)`;
      el.innerHTML = `<div class="node-header">${escapeHtml(node.name)}</div><div class="node-meta">${escapeHtml(node.category)} · ${escapeHtml(node.status)}</div><div class="ports inputs">${node.inputs.map(p => portHtml('input', p)).join('')}</div><div class="ports outputs">${node.outputs.map(p => portHtml('output', p)).join('')}</div>`;
      el.addEventListener('pointerdown', event => startNodeDrag(event, node));
      el.addEventListener('click', () => select(node.id)); nodesEl.appendChild(el);
    });
    nodesEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.scale})`;
    edgesEl.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px) scale(${state.scale})`;
    drawEdges(); emptyState.hidden = state.nodes.length > 0; updateInspector();
  }
  function portHtml(kind, p) { return `<div class="port ${kind}" data-port="${kind}:${p.id}"><span>${escapeHtml(p.name)} : ${escapeHtml(p.dataType)}</span><i class="handle" data-kind="${kind}" data-port-id="${p.id}"></i></div>`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
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
  function updateInspector() { const node = nodeById(state.selected); const disabled = !node; inspector.hint.textContent = node ? `节点 ID：${node.id}` : '选择一个节点查看详情。'; inspector.name.value = node?.name || ''; inspector.prompt.value = node?.prompt || ''; inspector.name.disabled = inspector.prompt.disabled = !node; inspector.status.textContent = `状态：${node?.status || '—'}`; }
  document.querySelector('#add-node').addEventListener('click', () => { const id = `node-${Date.now()}`; state.nodes.push({ id, name: 'NewNode', category: 'custom', prompt: '', status: 'draft', x: 300, y: 160, inputs: [{ id: 'input', name: 'input', dataType: 'int' }], outputs: [{ id: 'output', name: 'output', dataType: 'int' }] }); select(id); });
  document.querySelector('#clear-canvas').addEventListener('click', () => { state.nodes = []; state.edges = []; state.selected = null; render(); });
  document.querySelector('#fit-view').addEventListener('click', () => { state.scale = 1; state.offset = { x: 0, y: 0 }; render(); });
  canvas.addEventListener('wheel', event => { event.preventDefault(); state.scale = Math.min(1.8, Math.max(.55, state.scale * (event.deltaY < 0 ? 1.08 : .92))); render(); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (event.button !== 1 && !event.shiftKey && event.target !== canvas) return; state.panning = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y }; canvas.classList.add('is-panning'); });
  window.addEventListener('pointermove', event => { if (!state.panning) return; state.offset.x = state.panning.ox + event.clientX - state.panning.x; state.offset.y = state.panning.oy + event.clientY - state.panning.y; render(); });
  window.addEventListener('pointerup', () => { state.panning = null; canvas.classList.remove('is-panning'); });
  window.addEventListener('keydown', event => { if (event.key === 'Delete' && state.selected) { state.nodes = state.nodes.filter(n => n.id !== state.selected); state.edges = state.edges.filter(e => e.source[0] !== state.selected && e.target[0] !== state.selected); state.selected = null; render(); } });
  render();
})();
