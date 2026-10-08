'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadFrozen } = require('./rag-acceptance-eval.cjs');
function summarize(report, dataset, datasetHash) {
  if (report.datasetHash !== datasetHash) throw new Error('Dataset hash mismatch');
  const cases = new Map(dataset.cases.map((item) => [item.id, item]));
  const seen = new Set();
  for (const row of report.rows) {
    const item = cases.get(row.id);
    if (!item || seen.has(row.id) || row.type !== item.type || row.expected !== item.expectedAnswerable) throw new Error('Invalid, duplicate or mismatched case');
    if (typeof row.success !== 'boolean') throw new Error('Missing task verdict');
    seen.add(row.id);
  }
  const groups = Object.fromEntries([...new Set(dataset.cases.map((item) => item.type))].map((type) => {
    const rows = report.rows.filter((row) => row.type === type);
    const successes = rows.filter((row) => row.success).length;
    return [type, { expected: dataset.cases.filter((item) => item.type === type).length, completed: rows.length,
      successes, successRate: rows.length ? successes / rows.length : null,
      evidenceComplete: rows.filter((row) => row.evidenceComplete).length,
      errors: rows.filter((row) => row.error).length,
      citationFailures: rows.filter((row) => ['invalid', 'missing'].includes(row.grounding?.status)).length,
      safeAbstentions: rows.filter((row) => row.grounding?.semantic?.status === 'abstained' && row.grounding?.semantic?.safeForDelivery === true).length,
      factFailures: rows.filter((row) => require("../../electron/rag/abstention.cjs").semanticRejected(row.grounding?.semantic)).length,
      graderFailures: rows.filter((row) => !row.grade || row.grade.error).length,
      answerDisagreements: rows.filter((row) => row.grade && !row.grade.error &&
        (!row.grade.answersQuestion || !row.grade.allRequiredFacts || row.grade.inventedImplementation)).length }];
  }));
  return { datasetHash, role: report.role, labels: report.labels, model: report.model,
    sameModelGrader: report.sameModelGrader, scoringVersion: report.scoringVersion || 'task-agreement-v1-with-anchor', runtimeHashes: report.runtimeHashes, runtimeProfile: report.runtimeProfile,
    systemPromptProfile: report.systemPromptProfile || 'custom-read-only',
    terminalReport: !!report.finishedAt, totalExpected: cases.size, completed: seen.size,
    completeDatasetRun: !!report.finishedAt && seen.size === cases.size,
    successes: report.rows.filter((row) => row.success).length,
    successRate: seen.size ? report.rows.filter((row) => row.success).length / seen.size : null,
    missingIds: dataset.cases.filter((item) => !seen.has(item.id)).map((item) => item.id), groups,
    caveats: ['Model agreement with AI author labels, not human accuracy',
      'Exposed regression, not unseen holdout', 'Failure categories overlap',
      'Negative labels concern bounded author evidence; extra retrieved evidence needs review'] };
}
if (require.main === module) {
  try {
    const input = process.argv[2], output = process.argv[3];
    if (!input || !output) throw new Error('Usage: node scripts/eval/rag-agent-task-summary.cjs INPUT OUTPUT');
    const target = path.resolve(output);
    if (fs.existsSync(target)) throw new Error('Summary output already exists');
    const raw = fs.readFileSync(path.resolve(input));
    const { dataset, lock } = loadFrozen();
    const summary = { ...summarize(JSON.parse(raw.toString()), dataset, lock.datasetSha256),
      inputSha256: crypto.createHash('sha256').update(raw).digest('hex'), summarizedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ completed: summary.completed, successes: summary.successes, completeDatasetRun: summary.completeDatasetRun, groups: summary.groups }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { summarize };
