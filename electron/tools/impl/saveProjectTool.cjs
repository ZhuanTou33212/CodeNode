/**
 * save_project：保存当前工程（.cnode）到磁盘。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  registry.register(
    'save_project',
    '保存当前工程（.cnode）到磁盘。',
    { type: 'object', properties: {} },
    async (context) => {
      const filePath = await context.saveProject();
      return AgentToolResult.ok('已保存当前工程到 ' + (filePath || '磁盘'), { filePath: filePath || '' });
    }
  );
}

module.exports = { register };
