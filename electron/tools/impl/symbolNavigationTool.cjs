'use strict';

const path = require('path');
const fs = require('fs');
const { AgentToolResult } = require('../result.cjs');
const { getProjectIndex } = require('../../rag/index.cjs');
const { queryNavigation } = require('../../rag/symbolNavigation.cjs');
const { resolveInRoot, isCancelled } = require('./shared.cjs');

const TOOL_DESCRIPTIONS = {
  find_definition: '按区分大小写的符号名或限定名（如 Class.method）定位 TS/JS 定义。path/line 消除同名歧义。',
  find_references: '查 TS/JS 符号的静态引用位置；path/line 限定目标定义，引用仍在整个项目内查找。',
  get_callers: '查谁调用指定 TS/JS 符号，返回调用点、所属符号与目标候选。path/line 限定目标定义。',
  get_callees: '查指定 TS/JS 符号调用了谁；保留外部或无法解析的调用，并标注 unresolved。path/line 限定目标定义。',
};
const LIMITATIONS = '仅支持当前索引范围内的 TS/JS 静态候选，不做类型检查；动态调用、重导出、复杂 require 绑定及复杂接收者可能无法解析。name-only/member-candidate 不能证明实际调用关系。未命中不证明不存在；请 read_file 深读原文。';

function register(registry) {
  for (const [name, description] of Object.entries(TOOL_DESCRIPTIONS)) {
    registry.register(name, description + ' 结果为定位候选，需 read_file 核实；支持 offset 分页。', {
      type: 'object', additionalProperties: false,
      properties: {
        symbol: { type: 'string', minLength: 1, maxLength: 300, description: '符号名或限定名，区分大小写' },
        path: { type: 'string', maxLength: 1000, description: '目标定义所在的项目内文件或目录' },
        line: { type: 'integer', minimum: 1, description: '目标定义内部行号；与 path 一起用于消除歧义' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100, description: '每页结果数，默认 40，最多 100' },
        offset: { type: 'integer', minimum: 0, description: '分页起点，默认 0' },
      }, required: ['symbol'],
    }, async (context, args) => {
      if (isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
      if (!args.symbol.trim()) return AgentToolResult.error('symbol 不能为空');
      const root = path.resolve(context.projectRoot());
      let scope = '';
      if (args.path) {
        const full = resolveInRoot(root, args.path);
        if (!full) return AgentToolResult.error('路径越过项目边界或不可访问');
        if (!fs.existsSync(full)) return AgentToolResult.error('目标路径不存在：' + args.path);
        scope = path.relative(root, full).split(path.sep).join('/');
      }
      if (args.line && !scope) return AgentToolResult.error('line 必须与具体文件 path 一起使用');
      if (args.line && !fs.statSync(path.join(root, scope)).isFile()) return AgentToolResult.error('line 需要具体文件 path');
      const config = context.ragConfig();
      try {
        const index = getProjectIndex(root, { ...config, enabled: true, embedProvider: 'none', vectorStore: 'memory', rerankUrl: '' });
        const stats = await index.refreshAsync(false, context.signal());
        if (isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
        /** @type {any} */
        const result = queryNavigation(index.fileCache, name, { ...args, symbol: args.symbol.trim(), path: scope });
        result.index = { indexedFiles: stats.indexedFiles, skippedFiles: stats.skippedFiles,
          truncated: stats.truncated, parseErrorFiles: [...index.fileCache.values()].filter((entry) => entry.navigation?.parseErrors).length };
        result.limitations = LIMITATIONS;
        context.audit(name + ' symbol=' + args.symbol + ' count=' + result.count);
        const text = JSON.stringify(result);
        return AgentToolResult.ok(text, result, { modelContent: text });
      } catch (error) {
        if (error.name === 'AbortError' || isCancelled(context)) return AgentToolResult.failure('CANCELLED', '符号查询已取消');
        return AgentToolResult.error('符号查询失败：' + error.message);
      }
    });
  }
  require('../builtInOutputSchemas.cjs').declareOutputContracts(registry, Object.keys(TOOL_DESCRIPTIONS));
}

module.exports = { register };
