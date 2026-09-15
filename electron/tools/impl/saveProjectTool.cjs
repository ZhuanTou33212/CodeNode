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
      if (!filePath) {
        // 保存失败（路径越界 / 上下文只读 / 未接线）必须报错：谎报「已保存到磁盘」会让模型
        // 依据不存在的落盘结果继续推进（判据必须落在真实终态上）
        const reason = typeof context.saveError === 'function' ? context.saveError() : null;
        return AgentToolResult.error(
          '保存工程失败：' + (reason || '未写入任何文件（项目未打开、上下文只读或保存被拒绝）'),
          { filePath: '' }
        );
      }
      return AgentToolResult.ok('已保存当前工程到 ' + filePath, { filePath });
    }
  );
}

module.exports = { register };
