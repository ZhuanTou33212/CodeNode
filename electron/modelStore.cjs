/**
 * CodeNode 模型接入配置存储（多个模型：名称 / 模型 ID / API 地址 / API Key / 上下文 / 价格）
 * 持久化在 userData/models.json；首次运行时用 agent.properties 生成默认项。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function modelsFile(userDataDir) {
  return path.join(userDataDir, 'models.json');
}

function safeStorage() {
  try {
    const { safeStorage: storage } = require('electron');
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()
      && !(typeof storage.getSelectedStorageBackend === 'function' && storage.getSelectedStorageBackend() === 'basic_text')) return storage;
  } catch {}
  return null;
}

function encryptSecret(value) {
  const secret = String(value || '');
  if (!secret) return '';
  const storage = safeStorage();
  if (storage) {
    try { return 'safe:v1:' + storage.encryptString(secret).toString('base64'); } catch {}
  }
  throw new Error('安全密钥存储不可用，拒绝保存 API Key；原配置未修改');
}

function decryptSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.startsWith('safe:v1:')) {
    const storage = safeStorage();
    if (!storage) throw new Error('安全密钥存储不可用，无法解密；原配置已保留');
    try { return storage.decryptString(Buffer.from(raw.slice(8), 'base64')); }
    catch { throw new Error('密钥解密失败；原配置已保留，请恢复系统密钥环'); }
  }
  if (raw.startsWith('plain:v1:')) {
    try { return Buffer.from(raw.slice(9), 'base64').toString('utf8'); } catch { return ''; }
  }
  // 兼容旧版本明文 models.json；下次保存时会迁移为加密格式。
  return raw;
}

function toPublicModel(model) {
  const { apiKey, ...rest } = model || {};
  return { ...rest, apiKey: '', apiKeySet: !!apiKey };
}

function toPublicModels(models) {
  return (Array.isArray(models) ? models : []).map(toPublicModel);
}

/** 从 agent.properties 配置生成默认模型列表（保留用户已有的 apiBase/apiKey） */
function seedModels(cfg) {
  const apiBase = cfg.apiBase || 'https://api.deepseek.com';
  const apiKey = cfg.apiKey || '';
  return [
    {
      // DeepSeek V4.1 Flash：多模态（看图）+ thinking，1M 上下文
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4.1 Flash',
      model: 'deepseek-flash',
      apiBase,
      apiKey,
      contextWindow: 1_000_000,
      priceInput: 0.22,
      priceInputHit: 0.007,
      priceOutput: 0.66,
      supportsEffort: true,
      vision: true,
      enabled: true,
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4.1 Pro',
      model: 'deepseek-v4-pro',
      apiBase,
      apiKey,
      contextWindow: 1_000_000,
      priceInput: 0.66,
      priceInputHit: 0.022,
      priceOutput: 1.98,
      supportsEffort: true,
      // 实测 deepseek-v4-pro 不接受图片（会回「无法识别图片内容」），故不开视觉
      vision: false,
      enabled: true,
    },
  ];
}

/** 读取模型列表；文件不存在时返回 null（由调用方决定是否 seed） */
function readModels(userDataDir) {
  try {
    const raw = fs.readFileSync(modelsFile(userDataDir), 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models)) throw new Error('模型配置格式错误，拒绝覆盖原文件');
    return {
      models: data.models.map((model) => ({ ...model, apiKey: decryptSecret(model && model.apiKey) })),
      activeId: data.activeId || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeModels(userDataDir, models, activeId) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const persisted = (Array.isArray(models) ? models : []).map((model) => ({
    ...model,
    apiKey: encryptSecret(model && model.apiKey),
  }));
  const file = modelsFile(userDataDir);
  const temporary = file + '.' + require('crypto').randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify({ models: persisted, activeId }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/**
 * 获取模型配置（列表 + 当前激活 id）。
 * 首次运行（无 models.json）时用 agent.properties 初始化默认模型。
 */
function getModels(userDataDir, cfg) {
  const existing = readModels(userDataDir);
  if (existing) {
    return existing;
  }
  const models = seedModels(cfg || {});
  const activeId = models.length > 0 ? models[0].id : null;
  writeModels(userDataDir, models, activeId);
  return { models, activeId };
}

/** 按 id 查找模型配置 */
function findModel(userDataDir, cfg, id) {
  const store = getModels(userDataDir, cfg);
  return store.models.find((m) => m && m.id === id) || null;
}

module.exports = { getModels, findModel, readModels, writeModels, seedModels, toPublicModel, toPublicModels, encryptSecret, decryptSecret };
