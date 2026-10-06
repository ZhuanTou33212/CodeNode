const catalog = require('./modelEffortCatalog.json');
function capabilities(model = {}) {
  const name = String(model.model || model.id || '').toLowerCase();
  const preset = catalog.find(item => new RegExp(item.pattern).test(name));
  const raw = model.effortLevels || model.effort?.supported_levels || model.supported_reasoning_efforts || model.reasoning_efforts;
  let levels = Array.isArray(raw) ? [...new Set(raw.filter(value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value)))] : preset?.levels || [];
  if (!Array.isArray(raw) && /^gpt-6-(sol|luna)/.test(name)) levels = ['none', ...levels];
  const requestedDefault = model.defaultEffort || model.effort?.default_level || preset?.default;
  const defaultEffort = levels.includes(requestedDefault) ? requestedDefault : levels[0] || '';
  return { effortLevels: levels, defaultEffort };
}
module.exports = { capabilities };
