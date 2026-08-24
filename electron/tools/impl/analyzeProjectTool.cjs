/**
 * analyze_project：工程识别 + 源文件清单 + 逐文件结构摘要（import/class/function/变量）。
 * 用户在要求「分析文档/分析项目」时调用，Agent 应基于返回的结构化结果进行后续制作。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AgentToolResult } = require('../result.cjs');
const { scan, detectProjectInfo } = require('../projectScan.cjs');
const { readTextFile } = require('./shared.cjs');

function summarizeFile(root, meta) {
  const full = path.join(root, meta.relativePath);
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const read = readTextFile(full);
    if (!read.ok) return null;
    const lines = read.text.split('\n');
    const imports = [];
    const classes = [];
    const functions = [];
    const variables = [];
    for (const line of lines.slice(0, 300)) {
      const t = line.trim();
      if (!t) continue;
      if (/^(import|from|using|require\s*\(|include\s+|#include\s*<)/.test(t)) {
        imports.push(t.length > 120 ? t.slice(0, 120) : t);
        continue;
      }
      const cl = t.match(/\b(class|interface|trait|struct|type)\s+([A-Za-z_$][\w$]*)/);
      if (cl) {
        classes.push(cl[2]);
        continue;
      }
      if (/\b(def|func|function|fun)\s+/.test(t) || /^\s*(public|private|protected)\s+\w+\s+\w+\s*\(/.test(t)) {
        functions.push(t.length > 120 ? t.slice(0, 120) : t);
        continue;
      }
      const vr = t.match(/^\s*(let|var|const|val)\s+([A-Za-z_$][\w$]*)/);
      if (vr) variables.push(vr[1]);
    }
    return {
      path: meta.relativePath,
      language: meta.language,
      imports: imports.slice(0, 40),
      classes: [...new Set(classes)],
      functions: functions.slice(0, 40),
      variables: [...new Set(variables)].slice(0, 60),
      lineCount: lines.length,
    };
  } catch {
    return null;
  }
}

function register(registry) {
  registry.register(
    'analyze_project',
    '调用本地工程的识别与分析模块分析项目：返回构建系统、模块、入口候选、语言概览、源文件清单与逐文件结构摘要' +
      '（import/类/函数/变量）。path 为项目根目录（缺省当前项目）；analyzeFiles=true（默认）时逐文件提取结构摘要；' +
      'limitFiles 限制最多分析的文件数（默认 200）。用户在要求「分析文档/分析项目」时调用，Agent 应基于本工具返回的结构化结果进行后续制作。',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: '项目根目录（可选，缺省当前项目）' },
        analyzeFiles: { type: 'boolean', description: '是否逐文件提取结构摘要，默认 true' },
        limitFiles: { type: 'integer', description: '最多分析的文件数，默认 200，上限 1000' },
      },
      required: [],
    },
    async (context, args) => {
      const rawPath = String(args.path || '').trim();
      const root = rawPath ? path.resolve(rawPath) : path.resolve(context.projectRoot());
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return AgentToolResult.error('项目目录不存在: ' + root);
      const analyzeFiles = args.analyzeFiles !== false;
      const limit = typeof args.limitFiles === 'number' && Number.isFinite(args.limitFiles) ? Math.max(1, Math.min(1000, Math.floor(args.limitFiles))) : 1000;
      context.audit('analyze_project root=' + root);
      try {
        const info = detectProjectInfo(root);
        const result = scan(root);
        const files = result.sourceFiles;
        const fileAnalysis = [];
        if (analyzeFiles) {
          for (const f of files) {
            if (fileAnalysis.length >= limit) break;
            const entry = summarizeFile(root, f);
            if (entry) fileAnalysis.push(entry);
          }
        }
        const data = {
          root,
          buildSystem: info.buildSystem,
          mainCandidates: info.mainCandidates,
          modules: info.modules,
          jdks: info.jdks,
          sourceFileCount: files.length,
          assetFileCount: result.assetFiles.length,
          languageSummary: info.languages,
          files: files.slice(0, limit).map((f) => ({
            relativePath: f.relativePath,
            name: f.name,
            language: f.language,
            ext: f.ext,
            lineCount: f.lineCount,
          })),
        };
        if (fileAnalysis.length) data.fileAnalysis = fileAnalysis;
        data.analyzedFileCount = fileAnalysis.length;
        const text =
          '工程识别：' + info.buildSystem +
          '  |  入口候选: ' + (info.mainCandidates.length ? info.mainCandidates.join(', ') : '无') +
          '  |  源文件: ' + files.length +
          (analyzeFiles ? '  |  已分析: ' + fileAnalysis.length + ' 个文件' : '');
        return AgentToolResult.ok(text, data);
      } catch (e) {
        return AgentToolResult.error('工程分析失败：' + ((e && e.message) || e));
      }
    }
  );
}

module.exports = { register };
