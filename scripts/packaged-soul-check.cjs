'use strict';
const { app } = require('electron');
app.whenReady().then(async () => {
  if (!process.env.CODENODE_PACKAGED_ASAR) throw new Error('CODENODE_PACKAGED_ASAR is required');
  await require('./soul-evolution-test.cjs');
  app.exit(process.exitCode || 0);
}).catch(error => { console.error(error); app.exit(1); });
