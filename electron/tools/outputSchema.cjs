/**
 * Tool output contracts describe AgentToolResult.data, not the result envelope.
 * This intentionally supports a bounded JSON Schema subset. Unsupported assertions
 * are rejected at registration, never silently treated as a passing contract.
 * No remote refs, schema-driven code execution, or input-array fallback caps.
 */
'use strict';

const { isDeepStrictEqual } = require('node:util');
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const KEYWORDS = new Set([
  '$ref', '$defs', 'definitions', 'type', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else', 'properties', 'patternProperties', 'additionalProperties', 'required',
  'minProperties', 'maxProperties', 'items', 'additionalItems', 'prefixItems', 'contains',
  'minContains', 'maxContains', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);
const LIMIT = 100000;
const MAX_DEPTH = 64;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject non-JSON data instead of allowing serialization to change its meaning. */
function jsonIssue(value, path = '$', ancestors = new Set(), budget = { left: LIMIT }, depth = 0) {
  if (--budget.left < 0 || depth > MAX_DEPTH) return { path, keyword: 'limit', message: 'JSON 结构超过校验深度或节点上限' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return null;
  if (typeof value !== 'object') return { path, keyword: 'json', message: '输出必须是可序列化的 JSON 值' };
  if (ancestors.has(value)) return { path, keyword: 'json', message: '输出存在循环引用' };
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return { path, keyword: 'json', message: '输出必须是普通 JSON 对象' };
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value) && value.length > budget.left) return { path, keyword: 'limit', message: 'JSON 结构超过校验节点上限' };
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value);
    if (keys.length > budget.left) return { path, keyword: 'limit', message: 'JSON 结构超过校验节点上限' };
    for (const key of keys) {
      const entry = Object.getOwnPropertyDescriptor(value, key);
      if (!entry || !own(entry, 'value')) return { path: path + '.' + key, keyword: 'json', message: 'JSON 值不能包含空数组项或访问器' };
      // Tool payloads use optional object fields with undefined. JSON omits these
      // fields on the wire; required checks below still treat them as absent.
      if (!Array.isArray(value) && entry.value === undefined) continue;
      const issue = jsonIssue(entry.value, path + (Array.isArray(value) ? '[' + key + ']' : '.' + key), ancestors, budget, depth + 1);
      if (issue) return issue;
    }
    return null;
  } finally { ancestors.delete(value); }
}

function resolveRef(root, reference) {
  if (reference === '#') return root;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) throw new Error('仅支持文档内 JSON Pointer $ref');
  let target = root;
  for (const part of reference.slice(2).split('/')) {
    const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
    if ((!object(target) && !Array.isArray(target)) || !own(target, key)) throw new Error('$ref 目标不存在');
    target = target[key];
  }
  return target;
}

/** Validate and freeze the schema once, before the executor can have side effects. */
function normalizeOutputSchema(input) {
  if (input == null || input === 'none') return null;
  const issue = jsonIssue(input);
  if (issue) throw new Error('outputSchema ' + issue.path + ': ' + issue.message);
  const root = JSON.parse(JSON.stringify(input));
  const visited = new Set();
  function visit(schema, path) {
    if (typeof schema === 'boolean') return;
    if (!object(schema)) throw new Error('outputSchema ' + path + ': schema 必须是对象或布尔值');
    if (visited.has(schema)) return;
    visited.add(schema);
    const reject = (message) => { throw new Error('outputSchema ' + path + ': ' + message); };
    for (const key of Object.keys(schema)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) reject('不支持关键字 ' + key);
    }
    if (own(schema, 'type')) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.length || types.some((type) => !TYPES.has(type)) || new Set(types).size !== types.length) reject('type 声明不合法');
    }
    if (own(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length)) reject('enum 必须是非空数组');
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minContains', 'maxContains']) {
      if (own(schema, key) && (!Number.isInteger(schema[key]) || schema[key] < 0)) reject(key + ' 必须是非负整数');
    }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
      if (own(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) reject(key + ' 必须是有限数值');
    }
    if (own(schema, 'multipleOf') && schema.multipleOf <= 0) reject('multipleOf 必须大于零');
    if (own(schema, 'uniqueItems') && typeof schema.uniqueItems !== 'boolean') reject('uniqueItems 必须是布尔值');
    if (own(schema, 'required') && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string') || new Set(schema.required).size !== schema.required.length)) reject('required 必须是无重复的字段名数组');
    if (own(schema, 'pattern')) {
      if (typeof schema.pattern !== 'string') reject('pattern 必须是字符串');
      try { new RegExp(schema.pattern, 'u'); } catch { reject('pattern 不是有效正则表达式'); }
    }
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
      if (!own(schema, key)) continue;
      if (!object(schema[key])) reject(key + ' 必须是对象');
      for (const [name, child] of Object.entries(schema[key])) {
        if (key === 'patternProperties') {
          try { new RegExp(name, 'u'); } catch { reject('patternProperties 含无效正则表达式'); }
        }
        visit(child, path + '.' + key + '.' + name);
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (!own(schema, key)) continue;
      if (!Array.isArray(schema[key]) || !schema[key].length) reject(key + ' 必须是非空 schema 数组');
      schema[key].forEach((child, i) => visit(child, path + '.' + key + '[' + i + ']'));
    }
    for (const key of ['not', 'if', 'then', 'else', 'additionalProperties', 'additionalItems', 'contains']) {
      if (own(schema, key)) visit(schema[key], path + '.' + key);
    }
    if (own(schema, 'items')) {
      if (Array.isArray(schema.items)) {
        if (schema.prefixItems) reject('不能同时声明 tuple items 和 prefixItems');
        schema.items.forEach((child, i) => visit(child, path + '.items[' + i + ']'));
      } else visit(schema.items, path + '.items');
    }
    if (own(schema, '$ref')) {
      let target;
      try { target = resolveRef(root, schema.$ref); } catch (error) { reject(error.message); }
      visit(target, path + '.$ref');
    }
  }
  visit(root, '$');
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  return freeze(root);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

/** @returns {{path: string, keyword: string, message: string}|null} */
function validateOutput(value, schema) {
  if (schema == null || schema === 'none') return null;
  const issue = jsonIssue(value, '$.data');
  if (issue) return issue;
  const budget = { left: LIMIT };
  function check(data, rule, path, depth = 0) {
    const error = (keyword, message) => ({ path, keyword, message });
    if (--budget.left < 0 || depth > MAX_DEPTH) return error('limit', '输出校验超过深度或节点上限');
    if (rule === true) return null;
    if (rule === false) return error('falseSchema', '此输出被 schema 禁止');
    const descend = (child, childData = data, childPath = path) => check(childData, child, childPath, depth + 1);
    if (own(rule, '$ref')) { const found = descend(resolveRef(schema, rule.$ref)); if (found) return found; }
    if (own(rule, 'type') && !(Array.isArray(rule.type) ? rule.type : [rule.type]).some((type) => typeMatches(data, type))) return error('type', '输出字段类型不符合 schema');
    if (own(rule, 'const') && !isDeepStrictEqual(data, rule.const)) return error('const', '输出不符合指定常量');
    if (rule.enum && !rule.enum.some((item) => isDeepStrictEqual(data, item))) return error('enum', '输出不在声明的枚举中');
    for (const child of rule.allOf || []) { const found = descend(child); if (found) return found; }
    if (rule.anyOf || rule.oneOf) {
      for (const key of ['anyOf', 'oneOf']) {
        if (!rule[key]) continue;
        const branches = rule[key].map((child) => descend(child));
        const limit = branches.find((entry) => entry && entry.keyword === 'limit');
        if (limit) return limit;
        const matched = branches.filter((entry) => entry === null).length;
        if (key === 'anyOf' ? matched === 0 : matched !== 1) return error(key, '输出不符合 schema 分支条件');
      }
    }
    if (own(rule, 'not')) {
      const found = descend(rule.not);
      if (found && found.keyword === 'limit') return found;
      if (!found) return error('not', '输出匹配了禁止的 schema');
    }
    if (own(rule, 'if')) {
      const found = descend(rule.if);
      if (found && found.keyword === 'limit') return found;
      const branch = found ? 'else' : 'then';
      if (own(rule, branch)) { const branchError = descend(rule[branch]); if (branchError) return branchError; }
    }
    if (typeof data === 'string') {
      const length = [...data].length;
      if (rule.minLength != null && length < rule.minLength) return error('minLength', '输出字符串过短');
      if (rule.maxLength != null && length > rule.maxLength) return error('maxLength', '输出字符串过长');
      if (rule.pattern != null && !new RegExp(rule.pattern, 'u').test(data)) return error('pattern', '输出字符串不符合模式');
    }
    if (typeof data === 'number') {
      /** @type {Array<[string, boolean]>} */
      const bounds = [['minimum', data < rule.minimum], ['maximum', data > rule.maximum], ['exclusiveMinimum', data <= rule.exclusiveMinimum], ['exclusiveMaximum', data >= rule.exclusiveMaximum]];
      for (const [key, bad] of bounds) {
        if (rule[key] != null && bad) return error(key, '输出数字超出声明范围');
      }
      if (rule.multipleOf != null) {
        const ratio = data / rule.multipleOf;
        if (!Number.isFinite(ratio) || Math.abs(ratio - Math.round(ratio)) > 1e-10) return error('multipleOf', '输出数字不符合倍数约束');
      }
    }
    if (Array.isArray(data)) {
      if (rule.minItems != null && data.length < rule.minItems) return error('minItems', '输出数组项目过少');
      if (rule.maxItems != null && data.length > rule.maxItems) return error('maxItems', '输出数组项目过多');
      if (rule.uniqueItems) {
        for (let i = 0; i < data.length; i++) {
          for (let j = 0; j < i; j++) {
            if (--budget.left < 0) return error('limit', '输出校验超过节点上限');
            if (isDeepStrictEqual(data[i], data[j])) return error('uniqueItems', '输出数组包含重复项目');
          }
        }
      }
      const tuple = rule.prefixItems || (Array.isArray(rule.items) ? rule.items : null);
      for (let i = 0; i < data.length; i++) {
        const itemRule = tuple ? (i < tuple.length ? tuple[i] : rule.prefixItems ? rule.items : rule.additionalItems) : rule.items;
        if (itemRule !== undefined) { const found = descend(itemRule, data[i], path + '[' + i + ']'); if (found) return found; }
      }
      if (own(rule, 'contains')) {
        let count = 0;
        for (let i = 0; i < data.length; i++) {
          const found = descend(rule.contains, data[i], path + '[' + i + ']');
          if (found && found.keyword === 'limit') return found;
          if (!found) count++;
        }
        if (count < (rule.minContains == null ? 1 : rule.minContains) || (rule.maxContains != null && count > rule.maxContains)) return error('contains', '输出数组不符合 contains 数量约束');
      }
    }
    if (object(data)) {
      const keys = Object.keys(data).filter((key) => data[key] !== undefined);
      if (rule.minProperties != null && keys.length < rule.minProperties) return error('minProperties', '输出对象字段过少');
      if (rule.maxProperties != null && keys.length > rule.maxProperties) return error('maxProperties', '输出对象字段过多');
      for (const key of rule.required || []) {
        if (!own(data, key) || data[key] === undefined) return { path: path + '.' + key, keyword: 'required', message: '输出缺少必填字段' };
      }
      for (const key of keys) {
        let matched = false;
        if (rule.properties && own(rule.properties, key)) {
          matched = true;
          const found = descend(rule.properties[key], data[key], path + '.' + key);
          if (found) return found;
        }
        for (const [pattern, child] of Object.entries(rule.patternProperties || {})) {
          if (!new RegExp(pattern, 'u').test(key)) continue;
          matched = true;
          const found = descend(child, data[key], path + '.' + key);
          if (found) return found;
        }
        if (!matched && own(rule, 'additionalProperties')) {
          const found = descend(rule.additionalProperties, data[key], path + '.' + key);
          if (found) return found;
        }
      }
    }
    return null;
  }
  return check(value, schema, '$.data');
}

module.exports = { normalizeOutputSchema, validateOutput };
