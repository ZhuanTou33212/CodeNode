'use strict';
const fs = require('fs');
const path = require('path');
const feedback = require("../../electron/feedbackStore.cjs");
const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith('--root='));
const root = path.resolve(rootArg ? rootArg.slice(7) : process.cwd());
const reviewArg = args.find((arg) => arg.startsWith('--review='));
if (reviewArg) {
  const value = reviewArg.slice(9); const split = value.indexOf(':');
  if (split <= 0) throw new Error('--review=id:expectedOutput');
  const result = feedback.review(root, value.slice(0, split), value.slice(split + 1));
  console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1);
}
const result = feedback.exportDataset(root, { reviewedOnly: !args.includes('--include-candidates') });
const outputArg = args.find((arg) => arg.startsWith('--out='));
const json = JSON.stringify(result, null, 2);
if (outputArg) fs.writeFileSync(path.resolve(outputArg.slice(6)), json + '\n', 'utf8'); else process.stdout.write(json + '\n');
process.exit(result.ok ? 0 : 1);
