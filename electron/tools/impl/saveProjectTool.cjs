/**
 * save_project：保存当前工程（.cnode）到磁盘。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  // 显式契约：save_project 会**整体覆盖**工程文件（workflow.cnode），属于不可撤销的破坏性写，
  // 因此声明 requiresConfirmation='WRITE' —— 由注册表在执行前询问用户（不批准就不执行）。
  // 旧的 register() 合成契约不会触发注册表级确认，所以这是本阶段唯一行为有变化的工具。
  registry.registerDescriptor(
    {
      name: 'save_project',
      version: '1',
      description: '保存当前工程（.cnode）到磁盘。',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
      readOnly: false,
      idempotent: true,
      mutatesWorkspace: true,
      requiresConfirmation: 'WRITE',
      requiredCapability: 'project.save',
      timeoutMs: 60000,
      cachePolicy: { mode: 'none' },
      retryPolicy: { maxAttempts: 1, backoff: 'none', retryOn: [] },
      concurrencyPolicy: { parallelSafe: false },
      roleAllowlist: null,
    },
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
