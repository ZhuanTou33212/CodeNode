'use strict';
const assert = require('assert');
const { RequestBudget, withBudget } = require('../electron/requestBudget.cjs');
async function main() {
  const budget = new RequestBudget(100);
  const first = budget.reserve(80);
  assert.throws(() => budget.reserve(21), /额度不足/);
  first({ total_tokens: 20 });
  first({ total_tokens: 90 });
  assert.strictEqual(budget.used, 20);
  assert.strictEqual(budget.reserved, 0);
  const second = budget.reserve(80);
  second(null);
  assert.strictEqual(budget.used, 100);
  let invoked = false;
  await assert.rejects(withBudget({ requestBudget: budget, maxTokens: 10 }, [], [], async () => {
    invoked = true;
    return {};
  }), /额度不足/);
  assert.strictEqual(invoked, false);
  console.log('REQUEST BUDGET: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
