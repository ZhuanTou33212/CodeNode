export type GoalBudgetAttentionAction = 'reconcile-token-usage' | 'reconcile-cost-usage';

export interface GoalBudgetAttentionItem {
  id: string;
  action: GoalBudgetAttentionAction;
  owner: 'user';
  taskId: null;
  label: string;
  text: string;
}

interface GoalBudgetState {
  maxTokens?: number | null;
  tokenUnknown?: boolean;
  maxCostUsd?: number | null;
  costUnknown?: boolean;
}

interface GoalLike {
  id: string;
  budget?: GoalBudgetState;
}

/** Shared read-only projection for both Goal attention surfaces. */
export function goalBudgetAttention(goal: GoalLike): GoalBudgetAttentionItem[] {
  const budget = goal.budget;
  if (!budget) return [];

  const items: GoalBudgetAttentionItem[] = [];
  if (budget.maxTokens != null && budget.tokenUnknown === true) {
    items.push({
      id: `token-budget-${goal.id}`,
      action: 'reconcile-token-usage',
      owner: 'user',
      taskId: null,
      label: 'Token 待核对',
      text: '存在未知 Token 用量，请核对累计用量后继续',
    });
  }
  if (budget.maxCostUsd != null && budget.costUnknown === true) {
    items.push({
      id: `cost-budget-${goal.id}`,
      action: 'reconcile-cost-usage',
      owner: 'user',
      taskId: null,
      label: '费用待核对',
      text: '存在未知 ACP 费用，请核对累计 USD 费用后继续',
    });
  }
  return items;
}
