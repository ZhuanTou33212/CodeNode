'use strict';
// Admission needs headroom; completion only needs proof that the ceiling was not exceeded.
function evaluate(budget){
  const tokenCap=budget.maxTokens,costCap=budget.maxCostUsd;
  const costBudgetUnknown=costCap!=null&&budget.costUnknown===true;
  const tokenBudgetUnknown=tokenCap!=null&&budget.tokenUnknown===true;
  const tokenExceeded=tokenCap!=null&&budget.usedTokens>tokenCap;
  const costTolerance=Number.EPSILON*Math.max(1,Math.abs(costCap||0),Math.abs(budget.knownCostUsd||0))*4;
  const costExceeded=costCap!=null&&budget.knownCostUsd>costCap+costTolerance;
  const exhausted=(tokenCap!=null&&(tokenBudgetUnknown||budget.usedTokens>=tokenCap))||(costCap!=null&&(costBudgetUnknown||budget.knownCostUsd>=costCap));
  return{exhausted,costBudgetUnknown,tokenBudgetUnknown,tokenEstimateUsed:budget.tokenEstimateUsed===true,overLimit:tokenExceeded||costExceeded,withinLimits:!tokenBudgetUnknown&&!costBudgetUnknown&&!tokenExceeded&&!costExceeded};
}
module.exports={evaluate};
