/**
 * ask_user：向用户提问并等待回答（options 提供候选选项，否则自由输入）。
 */
'use strict';

const { AgentToolResult } = require('../result.cjs');

function register(registry) {
  registry.register(
    'ask_user',
    '向用户提问并等待回答。question 必填；options 可给出候选选项（用户选择其一），否则用户自由输入。',
    {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
        options: { type: 'array', items: { type: 'string' }, description: '候选选项' },
      },
      required: ['question'],
    },
    async (context, args) => {
      const question = String(args.question || '').trim();
      if (!question) return AgentToolResult.error('缺少 question');
      const options = [];
      if (Array.isArray(args.options)) {
        for (const item of args.options) {
          if (item != null && String(item).trim() !== '') options.push(String(item));
        }
      }
      const answer = await context.askUser(question, options);
      if (answer == null || String(answer).trim() === '') return AgentToolResult.error('用户未回答（已取消）');
      context.audit('ask_user ' + question + ' => ' + answer);
      return AgentToolResult.ok('用户回答：' + answer, { answer });
    }
  );
}

module.exports = { register };
