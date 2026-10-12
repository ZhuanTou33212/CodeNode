'use strict';
const {RequestBudget}=require('./requestBudget.cjs');

/** Bind one admitted Goal run to its reserved token and cost allowance. */
function apply(config,admission){
  const limits=config.limits||{};
  const configured=Number(limits.maxTotalTokens)>0?Number(limits.maxTotalTokens):600000;
  const tokenLimit=admission.tokenAllowance==null?configured:Math.min(configured,admission.tokenAllowance);
  const globalCost=Number(limits.maxCostUsd)||0,goalCost=admission.costAllowance;
  const costLimit=goalCost!=null?(globalCost>0?Math.min(globalCost,goalCost):goalCost):globalCost;
  config.limits={...limits,maxTotalTokens:tokenLimit,maxCostUsd:costLimit};
  config.requestBudget=new RequestBudget(tokenLimit,{retryLimit:limits.maxTotalRetries,costLimitUsd:costLimit,prices:config.costPrices});
  return config.requestBudget;
}
module.exports={apply};
