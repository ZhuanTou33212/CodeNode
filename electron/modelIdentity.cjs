function modelIdentity(model) {
  let endpoint = String(model.apiBase || '').replace(/\/+$/, '');
  let officialDeepSeek = false;
  try { const url = new URL(endpoint); officialDeepSeek = url.hostname.toLowerCase() === 'api.deepseek.com'; if (officialDeepSeek) url.pathname = url.pathname.replace(/\/v1\/?$/, ''); endpoint = url.toString().replace(/\/+$/, ''); } catch {}
  let name = String(model.model || model.id || '');
  if (officialDeepSeek && /^deepseek-v4(?:\.1)?-flash$/i.test(name)) name = 'deepseek-flash';
  if (officialDeepSeek && /^deepseek-v4\.1-pro$/i.test(name)) name = 'deepseek-v4-pro';
  const protocol = model.protocol || (/anthropic/i.test(endpoint) ? 'anthropic' : /googleapis/i.test(endpoint) ? 'gemini' : 'openai');
  return JSON.stringify([endpoint, protocol, name]);
}
function deduplicateModels(models, activeId) {
  const chosen = new Map(), aliases = Object.create(null);
  const score = model => (model.enabled !== false ? 8 : 0) + (!model.apiKeyError && !!model.apiKey ? 4 : 0) + (model.provider ? 1 : 0);
  for (const model of models) { const key = modelIdentity(model); const previous = chosen.get(key); if (!previous || score(model) >= score(previous)) chosen.set(key,model); }
  for (const model of models) aliases[model.id] = chosen.get(modelIdentity(model)).id;
  return {models:[...chosen.values()],activeId:aliases[activeId] || activeId || null,modelAliases:aliases};
}
module.exports = {modelIdentity,deduplicateModels};
