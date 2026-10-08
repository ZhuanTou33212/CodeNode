'use strict';
const { app } = require('electron');
app.whenReady().then(async () => {
  if (!process.env.CODENODE_PACKAGED_ASAR) throw new Error('CODENODE_PACKAGED_ASAR is required');
  await require("../core/symbol-navigation-test.cjs").main();
  console.log('PACKAGED SYMBOL NAVIGATION: PASS (actual app.asar, tools and unpacked AST worker)');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
