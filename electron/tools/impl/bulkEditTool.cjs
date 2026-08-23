/**
 * bulk_edit：大批量数据修改（高危，需用户确认）。action：
 *   create_nodes(count,name,prompt,connect)  批量创建任务节点
 *   create_files(list[{path,content}])       批量创建/写入文件（越界拒绝）
 *   create_assets(list[{path}])              批量创建文件节点（资产语义在新版并入文件节点）
 *   delete_nodes(nodeIds)                    批量删除工作台节点
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { ConfirmationLevel } = require('../context.cjs');
const { resolveInRoot } = require('./shared.cjs');

const MAX_BATCH = 200;

function intArg(args, key, fallback) {
  return typeof args[key] === 'number' && Number.isFinite(args[key]) ? Math.floor(args[key]) : fallback;
}

function stringArg(args, key, fallback) {
  const v = args[key];
  if (v == null || String(v) === 'null') return fallback;
  const t = String(v).trim();
  return t.length === 0 ? fallback : t;
}

function nodeIds(args) {
  const ids = [];
  const single = args.nodeId;
  if (single != null && String(single).trim() !== '') ids.push(String(single));
  if (Array.isArray(args.nodeIds)) {
    for (const item of args.nodeIds) {
      if (item != null && String(item).trim() !== '') ids.push(String(item));
    }
  }
  return ids;
}

function listSize(args) {
  return Array.isArray(args.list) ? args.list.length : 0;
}

function describe(action, args) {
  switch (action) {
    case 'create_nodes':
      return '批量创建 ' + intArg(args, 'count', 1) + ' 个工作台节点';
    case 'create_files':
      return '批量写入 ' + listSize(args) + ' 个文件';
    case 'create_assets':
      return '批量创建 ' + listSize(args) + ' 个文件节点';
    case 'delete_nodes':
      return '批量删除 ' + nodeIds(args).length + ' 个工作台节点';
    default:
      return '执行批量操作 ' + action;
  }
}

function detailFor(action, args) {
  const sb = [];
  sb.push('Agent 请求执行：' + describe(action, args) + '。');
  if (action === 'create_files' && Array.isArray(args.list)) {
    sb.push('将写入的文件：');
    let shown = 0;
    for (const item of args.list) {
      if (item && typeof item === 'object') {
        sb.push('  - ' + String(item.path || ''));
        shown++;
        if (shown >= 20) {
          sb.push('  …共 ' + args.list.length + ' 个文件');
          break;
        }
      }
    }
  } else if (action === 'delete_nodes') {
    sb.push('删除的节点数：' + nodeIds(args).length + '（此操作不可撤销，请确认）');
  }
  return sb.join('\n');
}

function register(registry) {
  registry.register(
    'bulk_edit',
    '大批量数据修改（高危，需用户确认）。action：create_nodes(count,name,prompt,connect) 批量创建任务节点；' +
      'create_files(list[{path,content}]) 批量创建/写入文件（越界拒绝）；create_assets(list[{path}]) 批量创建文件节点；' +
      'delete_nodes(nodeIds) 批量删除工作台节点。执行前会请求用户确认并解释将做什么。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create_nodes/create_files/create_assets/delete_nodes' },
        count: { type: 'integer', description: 'create_nodes 数量（最多 ' + MAX_BATCH + '）' },
        name: { type: 'string', description: 'create_nodes 名称前缀' },
        prompt: { type: 'string', description: 'create_nodes 职责说明' },
        connect: { type: 'boolean', description: 'create_nodes 是否串联' },
        list: { type: 'array', items: { type: 'object' }, description: 'create_files/create_assets 的条目列表' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'delete_nodes 目标节点 id' },
      },
      required: ['action'],
    },
    async (context, args) => {
      const action = String(args.action || '').trim().toLowerCase();
      if (!action) return AgentToolResult.error('缺少 action');
      const what = describe(action, args);
      const ok = await context.confirm(ConfirmationLevel.HIGH, what, detailFor(action, args));
      if (!ok) return AgentToolResult.error('已取消批量操作');
      try {
        switch (action) {
          case 'create_nodes':
            return await createNodes(context, args);
          case 'create_files':
            return await createFiles(context, args);
          case 'create_assets':
            return await createAssets(context, args);
          case 'delete_nodes':
            return await deleteNodes(context, args);
          default:
            return AgentToolResult.error('未知 action: ' + action);
        }
      } catch (e) {
        return AgentToolResult.error('批量操作失败：' + ((e && e.message) || e));
      }
    }
  );
}

async function createNodes(context, args) {
  const count = Math.max(1, Math.min(MAX_BATCH, intArg(args, 'count', 1)));
  const baseName = stringArg(args, 'name', '节点');
  const prompt = stringArg(args, 'prompt', '说明这个节点应完成的工作');
  const connect = args.connect === true;
  const ids = [];
  await context.mutateWorkbench((model) => {
    const created = [];
    for (let i = 0; i < count; i++) {
      const node = model.addNode('task', { label: count === 1 ? baseName : baseName + (i + 1), status: 'pending', prompt }, 120 + (i % 10) * 40, 120 + Math.floor(i / 10) * 90);
      created.push(node);
      ids.push(node.id);
    }
    if (connect) {
      for (let i = 0; i + 1 < created.length; i++) model.connect(created[i], created[i + 1]);
    }
  });
  context.audit('bulk_edit create_nodes count=' + count);
  return AgentToolResult.ok('已批量创建 ' + ids.length + ' 个节点', { action: 'create_nodes', nodeIds: ids, count: ids.length });
}

async function createFiles(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  if (list.length === 0) return AgentToolResult.error('缺少 list（要写入的文件列表）');
  const root = path.resolve(context.projectRoot());
  const written = [];
  const errors = [];
  let n = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      n++;
      continue;
    }
    const relative = String(item.path || '').trim();
    const content = item.content == null ? '' : String(item.content);
    if (!relative) {
      errors.push('第 ' + (n + 1) + ' 项缺 path');
      n++;
      continue;
    }
    const target = resolveInRoot(root, relative);
    if (!target) {
      errors.push('路径越过项目边界: ' + relative);
      n++;
      continue;
    }
    try {
      if (path.dirname(target)) fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf-8');
      written.push(relative);
    } catch (e) {
      errors.push(relative + ': ' + ((e && e.message) || e));
    }
    context.notifyFileChange(relative, 'create', content.length + ' 字节');
    n++;
  }
  context.audit('bulk_edit create_files written=' + written.length + ' errors=' + errors.length);
  if (written.length === 0) return AgentToolResult.error('写入失败：' + errors.join('；'));
  const data = { action: 'create_files', written, count: written.length };
  if (errors.length) data.errors = errors;
  return AgentToolResult.ok('已批量写入 ' + written.length + ' 个文件' + (errors.length ? '，失败 ' + errors.length + ' 项' : ''), data);
}

async function createAssets(context, args) {
  const list = Array.isArray(args.list) ? args.list : [];
  if (list.length === 0) return AgentToolResult.error('缺少 list（资产列表）');
  const ids = [];
  await context.mutateWorkbench((model) => {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const relative = String(item.path || '').trim();
      if (!relative) continue;
      const name = relative.includes('/') ? relative.slice(relative.lastIndexOf('/') + 1) : relative;
      const node = model.addNode('file', { label: name, status: 'pending', filePath: relative }, 200, 200 + ids.length * 40);
      ids.push(node.id);
    }
  });
  context.audit('bulk_edit create_assets count=' + ids.length);
  return AgentToolResult.ok('已批量创建 ' + ids.length + ' 个文件节点', { action: 'create_assets', nodeIds: ids, count: ids.length });
}

async function deleteNodes(context, args) {
  const ids = nodeIds(args);
  if (ids.length === 0) return AgentToolResult.error('缺少 nodeIds');
  const deleted = [];
  const errors = [];
  await context.mutateWorkbench((model) => {
    for (const id of ids) {
      const node = model.byId(id);
      if (!node) {
        errors.push('节点不存在: ' + id);
        continue;
      }
      model.removeNode(node);
      deleted.push(id);
    }
  });
  context.audit('bulk_edit delete_nodes count=' + deleted.length);
  if (deleted.length === 0) return AgentToolResult.error('删除失败：' + errors.join('；'));
  const data = { action: 'delete_nodes', deleted, count: deleted.length };
  if (errors.length) data.errors = errors;
  return AgentToolResult.ok('已批量删除 ' + deleted.length + ' 个节点' + (errors.length ? '，失败 ' + errors.length + ' 项' : ''), data);
}

module.exports = { register };
