'use strict';
const { app } = require('electron');
app.whenReady().then(async()=>{
  if(!process.env.CODENODE_PACKAGED_ASAR)throw Error('CODENODE_PACKAGED_ASAR required');
  await require("../core/coding-safety-test.cjs").main();
  console.log('PACKAGED CODING SAFETY: PASS');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
