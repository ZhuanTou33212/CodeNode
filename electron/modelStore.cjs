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
    if (storage && typeof storage.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable()) return storage;
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
  // 仅用于 Electron safeStorage 不可用的开发/迁移环境；正常桌面运行会使用系统密钥环/DPAPI。
  return 'plain:v1:' + Buffer.from(secret, 'utf8').toString('base64');
}

function decryptSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.startsWith('safe:v1:')) {
    const storage = safeStorage();
    if (!storage) return '';
    try { return storage.decryptString(Buffer.from(raw.slice(8), 'base64')); } catch { return ''; }
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
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      model: 'deepseek-v4-flash',
      apiBase,
      apiKey,
      contextWindow: 1_000_000,
      priceInput: 0.22,
      priceInputHit: 0.007,
      priceOutput: 0.66,
      supportsEffort: true,
      enabled: true,
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      model: 'deepseek-v4-pro',
      apiBase,
      apiKey,
      contextWindow: 1_000_000,
      priceInput: 0.66,
      priceInputHit: 0.022,
      priceOutput: 1.98,
      supportsEffort: true,
      enabled: true,
    },
  ];
}

/** 读取模型列表；文件不存在时返回 null（由调用方决定是否 seed） */
function readModels(userDataDir) {
  try {
    const raw = fs.readFileSync(modelsFile(userDataDir), 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.models)) return null;
    return {
      models: data.models.map((model) => ({ ...model, apiKey: decryptSecret(model && model.apiKey) })),
      activeId: data.activeId || null,
    };
  } catch {
    return null;
  }
}

function writeModels(userDataDir, models, activeId) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const persisted = (Array.isArray(models) ? models : []).map((model) => ({
    ...model,
    apiKey: encryptSecret(model && model.apiKey),
  }));
  fs.writeFileSync(modelsFile(userDataDir), JSON.stringify({ models: persisted, activeId }, null, 2), 'utf-8');
}

/**
 * 获取模型配置（列表 + 当前激活 id）。
 * 首次运行（无 models.json）时用 agent.properties 初始化默认模型。
 */
function getModels(userDataDir, cfg) {
  const existing = readModels(userDataDir);
  if (existing && existing.models.length > 0) {
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
