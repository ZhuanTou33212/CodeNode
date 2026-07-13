import fs from 'node:fs/promises';

const input = process.argv[2]
  ? await fs.readFile(process.argv[2], 'utf8')
  : await new Promise(resolve => { let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { value += chunk; }); process.stdin.on('end', () => resolve(value)); });

const rules = [
  { category: 'dependency-resolution', scope: 'project', patterns: [/Could not resolve dependencies/i, /Could not find artifact/i, /Failed to read artifact descriptor/i, /Non-resolvable parent POM/i] },
  { category: 'plugin-resolution', scope: 'project', patterns: [/No plugin found for prefix/i, /Plugin .* could not be resolved/i] },
  { category: 'compilation', scope: 'source', patterns: [/COMPILATION ERROR/i, /\[ERROR\].*\.java:\[?\d+[,\]]/i] },
  { category: 'test-failure', scope: 'project', patterns: [/There are test failures/i, /Failures: [1-9]/i, /Errors: [1-9]/i] }
];
const matches = rules.filter(rule => rule.patterns.some(pattern => pattern.test(input))).map(({ category, scope }) => ({ category, scope }));
const result = { status: matches.length ? 'diagnostic' : 'unknown', diagnostics: matches, summary: matches.length ? 'Maven output matched known diagnostic categories.' : 'No known Maven diagnostic category matched.' };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
