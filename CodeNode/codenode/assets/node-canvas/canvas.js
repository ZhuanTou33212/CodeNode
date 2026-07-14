(() => {
  const canvas = document.querySelector('#canvas');
  const nodesEl = document.querySelector('#nodes');
  const edgesEl = document.querySelector('#edges');
  const emptyState = document.querySelector('#empty-state');
  const inspector = { hint: document.querySelector('#selection-hint'), name: document.querySelector('#node-name'), prompt: document.querySelector('#node-prompt'), codeEditor: document.querySelector('#node-code-editor'), inputCount: document.querySelector('#input-port-count'), outputCount: document.querySelector('#output-port-count'), inputConfig: document.querySelector('#input-port-config'), outputConfig: document.querySelector('#output-port-config'), language: document.querySelector('#node-language'), code: document.querySelector('#node-code'), request: document.querySelector('#request-preview'), make: document.querySelector('#make-node'), status: document.querySelector('#node-status'), validation: document.querySelector('#validation-message') };
  const runOutput = document.querySelector('#run-output');
  const reviewPanel = document.querySelector('.code-review-panel');
  const inspectorPanel = document.querySelector('.inspector');
  const runPanel = document.querySelector('#run-panel');
  const queuePanel = document.querySelector('.request-queue-panel');
  const queueList = document.querySelector('#request-queue-list');
  const queueStatus = document.querySelector('#request-queue-status');
  const state = { nodes: [], edges: [], selected: null, scale: 1, offset: { x: 0, y: 0 }, connecting: null, panning: null };
  let language = 'java';
  let portSequence = 0;
  const portTypes = [
    ['auto', '自动'], ['integer', '整数'], ['decimal', '小数'], ['string', '文本'],
    ['boolean', '布尔'], ['object', '对象'], ['array', '数组'], ['any', '任意']
  ];
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
  function dataTypeLabel(value) { return portTypes.find(([type]) => type === value)?.[1] || value || '自动'; }
  function portHtml(kind, p) { const direction = kind === 'input' ? '输入' : '输出'; return `<div class="port ${kind}" data-port="${kind}:${p.id}"><span>${direction}：${escapeHtml(p.name)} · ${escapeHtml(dataTypeLabel(p.dataType))}</span><i class="handle" data-kind="${kind}" data-port-id="${p.id}"></i></div>`; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
  function languageLabel(value) { return ({ java: 'Java', powershell: 'PowerShell', go: 'Go' })[value] || 'Java'; }
  function generatedCode(node) { if (node.language === 'powershell') return `param([int]$左值, [int]$右值)\n$result = $左值 + $右值\n$result`; if (node.language === 'go') return `func Execute(left int, right int) int {\n    return left + right\n}`; return `public static int 执行(int 左值, int 右值) {\n    return 左值 + 右值;\n}`; }
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
    if (!sourcePort || !target) { inspector.validation.textContent = '连接被拒绝：端口不存在。'; return; }
    if (target.dataType === 'auto') { target.dataType = sourcePort.dataType; inspector.validation.textContent = `输入端口已自适应为${dataTypeLabel(sourcePort.dataType)}。`; }
    else if (target.dataType !== 'any' && sourcePort.dataType !== 'any' && target.dataType !== sourcePort.dataType) { inspector.validation.textContent = '连接被拒绝：端口类型不兼容。'; return; }
    state.edges = state.edges.filter(edge => !(edge.target[0] === targetNodeId && edge.target[1] === target.id)); state.edges.push({ id: `e${Date.now()}`, source: state.connecting.source, target: [targetNodeId, target.id], dataType: sourcePort.dataType }); render();
  }
  function drawEdges() {
    edgesEl.innerHTML = ''; state.edges.forEach(edge => { const a = handlePoint(edge.source[0], 'output', edge.source[1]); const b = handlePoint(edge.target[0], 'input', edge.target[1]); if (!a || !b) return; const bend = Math.max(40, Math.abs(b.x - a.x) * .45); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`); path.setAttribute('class', 'edge'); edgesEl.appendChild(path); });
  }
  function handlePoint(nodeId, kind, portId) { const handle = nodesEl.querySelector(`.node[data-id="${nodeId}"] .handle[data-kind="${kind}"][data-port-id="${portId}"]`); if (!handle) return null; const rect = handle.getBoundingClientRect(); const canvasRect = canvas.getBoundingClientRect(); return { x: (rect.left + rect.width / 2 - canvasRect.left - state.offset.x) / state.scale, y: (rect.top + rect.height / 2 - canvasRect.top - state.offset.y) / state.scale }; }
  function newPort(kind, index) { return { id: `${kind}-${Date.now()}-${++portSequence}`, name: `${kind === 'input' ? '输入' : '输出'}${index + 1}`, dataType: kind === 'input' ? 'auto' : 'integer', required: kind === 'input' }; }
  function resizePorts(node, kind, requestedCount) {
    const ports = kind === 'input' ? node.inputs : node.outputs;
    const count = Math.min(32, Math.max(0, Number.parseInt(requestedCount, 10) || 0));
    while (ports.length < count) ports.push(newPort(kind, ports.length));
    if (ports.length > count) {
      const removed = new Set(ports.splice(count).map(item => item.id));
      state.edges = state.edges.filter(edge => !removed.has((kind === 'input' ? edge.target : edge.source)[1]));
    }
    render();
  }
  function portTypeOptions(kind, selected) { return portTypes.filter(([type]) => kind === 'input' || type !== 'auto').map(([type, label]) => `<option value="${type}" ${type === selected ? 'selected' : ''}>${label}</option>`).join(''); }
  function renderPortConfig(node, kind) {
    const ports = kind === 'input' ? node.inputs : node.outputs;
    const container = kind === 'input' ? inspector.inputConfig : inspector.outputConfig;
    container.innerHTML = '';
    ports.forEach(portItem => {
      const row = document.createElement('div');
      row.className = 'port-config-row';
      row.innerHTML = `<input value="${escapeAttr(portItem.name)}" aria-label="${kind === 'input' ? '输入' : '输出'}端口名称"><select aria-label="${kind === 'input' ? '输入' : '输出'}端口类型">${portTypeOptions(kind, portItem.dataType)}</select><button type="button" aria-label="删除端口">×</button>`;
      const nameInput = row.querySelector('input');
      const typeSelect = row.querySelector('select');
      nameInput.addEventListener('input', () => { portItem.name = nameInput.value || (kind === 'input' ? '输入' : '输出'); const label = nodesEl.querySelector(`.node[data-id="${node.id}"] [data-port="${kind}:${portItem.id}"] span`); if (label) label.textContent = `${kind === 'input' ? '输入' : '输出'}：${portItem.name} · ${dataTypeLabel(portItem.dataType)}`; });
      typeSelect.addEventListener('change', () => { portItem.dataType = typeSelect.value; render(); });
      row.querySelector('button').addEventListener('click', () => { const index = ports.indexOf(portItem); if (index >= 0) ports.splice(index, 1); state.edges = state.edges.filter(edge => (kind === 'input' ? edge.target : edge.source)[1] !== portItem.id); render(); });
      row.addEventListener('keydown', event => event.stopPropagation());
      container.appendChild(row);
    });
  }
  function updateInspector() {
    const node = nodeById(state.selected);
    inspector.hint.textContent = node ? `节点编号：${node.id}` : '选择一个节点查看详情。';
    inspector.name.value = node?.name || ''; inspector.prompt.value = node?.prompt || ''; inspector.codeEditor.value = node?.code || '';
    inspector.name.disabled = inspector.prompt.disabled = inspector.codeEditor.disabled = inspector.inputCount.disabled = inspector.outputCount.disabled = inspector.make.disabled = !node;
    inspector.inputCount.value = node?.inputs.length || 0; inspector.outputCount.value = node?.outputs.length || 0;
    inspector.inputConfig.innerHTML = ''; inspector.outputConfig.innerHTML = '';
    if (node) { renderPortConfig(node, 'input'); renderPortConfig(node, 'output'); }
    inspector.status.textContent = `状态：${node?.status || '—'}`; inspector.language.textContent = `语言：${languageLabel(node?.language || language)}`; inspector.code.value = node?.code || ''; inspector.code.disabled = !node; inspector.request.value = node ? JSON.stringify(buildRequest(node), null, 2) : '';
  }
  document.querySelector('#add-node').addEventListener('click', () => { const id = `node-${Date.now()}`; state.nodes.push({ id, name: '空白节点', category: '自定义', prompt: '', language, code: '', status: '草稿', x: 300, y: 160, inputs: [], outputs: [] }); select(id); });
  inspector.name.addEventListener('input', () => { const node = nodeById(state.selected); if (node) { node.name = inspector.name.value || '空白节点'; const card = nodesEl.querySelector(`[data-id="${node.id}"] .node-header`); if (card) card.textContent = node.name; } });
  inspector.prompt.addEventListener('input', () => { const node = nodeById(state.selected); if (node) node.prompt = inspector.prompt.value; });
  inspector.codeEditor.addEventListener('input', () => { const node = nodeById(state.selected); if (node) { node.code = inspector.codeEditor.value; inspector.code.value = node.code; } });
  inspector.inputCount.addEventListener('change', () => { const node = nodeById(state.selected); if (node) resizePorts(node, 'input', inspector.inputCount.value); });
  inspector.outputCount.addEventListener('change', () => { const node = nodeById(state.selected); if (node) resizePorts(node, 'output', inspector.outputCount.value); });
  [inspector.name, inspector.prompt, inspector.codeEditor, inspector.inputCount, inspector.outputCount].forEach(input => input.addEventListener('keydown', event => event.stopPropagation()));
  function buildRequest(node, mode = node.buildMode || 'program') { return { requestId: node.id, action: mode === 'node' ? 'build-node' : 'build-program', language: node.language || language, prompt: node.prompt || '', output: { workspaceRoot: 'E:\\CodeNode', relativePath: document.querySelector('#output-path').value.trim() || 'output/CodeNodeProgram' }, nodes: state.nodes, edges: state.edges, requiresConfirmation: true }; }
  function buildSelected(mode) { const node = nodeById(state.selected); if (!node) { inspector.validation.textContent = '请先选择一个节点。'; return; } node.language = language; node.buildMode = mode; node.status = mode === 'program' ? '等待 Codex 制作程序' : '等待 Codex 制作节点'; const request = buildRequest(node, mode); inspector.request.value = JSON.stringify(request, null, 2); inspector.validation.textContent = mode === 'node' ? '节点制作请求已生成，可提交到 MCP 队列。' : '程序制作请求已生成，可提交到 MCP 队列。'; render(); }
  inspector.make.addEventListener('click', () => buildSelected('node'));
  document.querySelector('#build-select').addEventListener('change', event => { const mode = event.target.value; event.target.value = ''; if (mode) buildSelected(mode); });
  document.querySelector('#copy-request').addEventListener('click', async () => { const node = nodeById(state.selected); if (!node) { inspector.validation.textContent = '请先选择一个节点。'; return; } const text = JSON.stringify(buildRequest(node), null, 2); inspector.request.value = text; inspector.request.select(); try { await navigator.clipboard.writeText(text); inspector.validation.textContent = '制作请求已复制，请粘贴到 Codex 对话。'; } catch { inspector.validation.textContent = '已选中制作请求，请按 Ctrl+C 后粘贴到 Codex 对话。'; } });
  function markdownRequest(node) { const request = buildRequest(node); return `---\ncodenodeRequest: ${request.requestId}\naction: ${request.action}\nlanguage: ${request.language}\n---\n\n# ${node.name}\n\n${node.prompt || '未填写制作要求'}\n\n## BuildRequest\n\n\`\`\`json\n${JSON.stringify(request, null, 2)}\n\`\`\`\n`; }
  function queueActionLabel(action) { return action === 'build-node' ? '请求制作成节点' : '请求制作成程序'; }
  async function refreshRequestQueue() {
    queueStatus.textContent = '正在读取 MCP 队列…';
    try {
      const response = await fetch('http://127.0.0.1:32145/markdown');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      queueList.innerHTML = '';
      result.requests.forEach(request => {
        const item = document.createElement('li');
        item.className = 'request-queue-item';
        item.textContent = `[请求${request.sequence}：${request.nodeName}(${queueActionLabel(request.action)})]`;
        queueList.appendChild(item);
      });
      queueStatus.textContent = result.requests.length ? `当前排队 ${result.requests.length} 个请求` : '当前没有排队请求。';
    } catch (error) {
      queueList.innerHTML = '';
      queueStatus.textContent = `MCP 队列未连接：${error.message}`;
    }
  }
  document.querySelector('#refresh-request-queue').addEventListener('click', refreshRequestQueue);
  document.querySelector('#send-request').addEventListener('click', async () => { const node = nodeById(state.selected); if (!node) { inspector.validation.textContent = '请先选择一个节点。'; return; } inspector.validation.textContent = '正在提交到 CodeNode MCP 队列…'; try { const response = await fetch('http://127.0.0.1:32145/markdown', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CodeNode-Bridge': '1' }, body: JSON.stringify({ filename: `${node.id}-${Date.now()}.md`, content: markdownRequest(node) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); node.status = '已进入 CodeNode MCP 队列'; inspector.validation.textContent = `已排队 ${result.filename}；MCP 不能主动写入当前对话，请在 Codex 中输入“${result.nextPrompt || '处理最新 CodeNode 请求'}”。`; await refreshRequestQueue(); render(); } catch (error) { inspector.validation.textContent = `MCP 队列未连接：${error.message}。请确认 CodeNode 插件已安装，并重启 Codex 后重试。`; } });
  document.querySelector('#language-select').addEventListener('change', event => { language = event.target.value; const node = nodeById(state.selected); if (node) node.language = language; updateInspector(); render(); });
  document.querySelector('#clear-canvas').addEventListener('click', () => { state.nodes = []; state.edges = []; state.selected = null; render(); });
  document.querySelector('#fit-view').addEventListener('click', () => { state.scale = 1; state.offset = { x: 0, y: 0 }; render(); });
  let reviewWidth = 320;
  let inspectorWidth = 320;
  let queueWidth = 280;
  let runHeight = 138;
  document.querySelector('#toggle-code-review').addEventListener('click', event => { const collapsed = reviewPanel.classList.toggle('code-review-collapsed'); document.documentElement.style.setProperty('--review-width', collapsed ? '44px' : `${reviewWidth}px`); event.currentTarget.textContent = collapsed ? '展开' : '侧栏'; event.currentTarget.setAttribute('aria-expanded', String(!collapsed)); });
  document.querySelector('#toggle-inspector').addEventListener('click', event => { const collapsed = inspectorPanel.classList.toggle('inspector-collapsed'); document.documentElement.style.setProperty('--inspector-width', collapsed ? '44px' : `${inspectorWidth}px`); event.currentTarget.textContent = collapsed ? '展开' : '侧栏'; event.currentTarget.setAttribute('aria-expanded', String(!collapsed)); });
  document.querySelector('#toggle-request-queue').addEventListener('click', event => { const collapsed = queuePanel.classList.toggle('request-queue-collapsed'); document.documentElement.style.setProperty('--queue-width', collapsed ? '44px' : `${queueWidth}px`); event.currentTarget.textContent = collapsed ? '展开' : '侧栏'; event.currentTarget.setAttribute('aria-expanded', String(!collapsed)); });
  document.querySelector('#toggle-run-panel').addEventListener('click', event => { const collapsed = runPanel.classList.toggle('is-collapsed'); document.documentElement.style.setProperty('--run-height', collapsed ? '38px' : `${runHeight}px`); event.currentTarget.textContent = collapsed ? '展开' : '收起'; event.currentTarget.setAttribute('aria-expanded', String(!collapsed)); });
  function bindResizer(handle, isCollapsed, onMove) {
    let dragging = false;
    const move = event => { if (dragging) onMove(event); };
    const stop = event => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-resizing');
      if (event?.pointerId !== undefined) {
        try { handle.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
      }
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || isCollapsed()) return;
      event.preventDefault();
      dragging = true;
      handle.classList.add('is-resizing');
      try { handle.setPointerCapture(event.pointerId); } catch { /* unsupported capture is harmless */ }
    });
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('lostpointercapture', stop);
    window.addEventListener('blur', stop);
  }
  bindResizer(document.querySelector('#review-resizer'), () => reviewPanel.classList.contains('code-review-collapsed'), event => { reviewWidth = Math.min(520, Math.max(220, window.innerWidth - event.clientX - inspectorWidth)); document.documentElement.style.setProperty('--review-width', `${reviewWidth}px`); });
  bindResizer(document.querySelector('#inspector-resizer'), () => inspectorPanel.classList.contains('inspector-collapsed'), event => { inspectorWidth = Math.min(520, Math.max(220, window.innerWidth - event.clientX)); document.documentElement.style.setProperty('--inspector-width', `${inspectorWidth}px`); });
  bindResizer(document.querySelector('#queue-resizer'), () => queuePanel.classList.contains('request-queue-collapsed'), event => { queueWidth = Math.min(480, Math.max(220, window.innerWidth - event.clientX - reviewWidth - inspectorWidth)); document.documentElement.style.setProperty('--queue-width', `${queueWidth}px`); });
  if (window.matchMedia('(max-width: 900px)').matches) { queuePanel.classList.add('request-queue-collapsed'); reviewPanel.classList.add('code-review-collapsed'); inspectorPanel.classList.add('inspector-collapsed'); document.querySelector('#toggle-request-queue').textContent = '展开'; document.querySelector('#toggle-request-queue').setAttribute('aria-expanded', 'false'); document.querySelector('#toggle-code-review').textContent = '展开'; document.querySelector('#toggle-code-review').setAttribute('aria-expanded', 'false'); document.querySelector('#toggle-inspector').textContent = '展开'; document.querySelector('#toggle-inspector').setAttribute('aria-expanded', 'false'); }
  runOutput.textContent = '尚未运行节点。生成程序后，确认执行结果会显示在这里。';
  refreshRequestQueue();
  canvas.addEventListener('wheel', event => { event.preventDefault(); state.scale = Math.min(1.8, Math.max(.55, state.scale * (event.deltaY < 0 ? 1.08 : .92))); render(); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (event.button !== 1 && !event.shiftKey && event.target !== canvas) return; state.panning = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y }; canvas.classList.add('is-panning'); });
  window.addEventListener('pointermove', event => { if (!state.panning) return; state.offset.x = state.panning.ox + event.clientX - state.panning.x; state.offset.y = state.panning.oy + event.clientY - state.panning.y; render(); });
  window.addEventListener('pointerup', () => { state.panning = null; canvas.classList.remove('is-panning'); });
  window.addEventListener('keydown', event => { if (event.key === 'Delete' && state.selected) { state.nodes = state.nodes.filter(n => n.id !== state.selected); state.edges = state.edges.filter(e => e.source[0] !== state.selected && e.target[0] !== state.selected); state.selected = null; render(); } });
  render();
})();
