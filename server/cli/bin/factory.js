#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// When running from server/ project root:
// dist is at server/dist/cli/index.js
// source is at server/cli/index.ts
const distCli = path.join(__dirname, '../../dist/cli/index.js');
const srcCli = path.join(__dirname, '../index.ts');

if (fs.existsSync(distCli)) {
  require(distCli);
} else {
  const tsxBin = path.join(__dirname, '../../node_modules/.bin/tsx');
  const result = spawnSync(tsxBin, [srcCli, ...process.argv.slice(2)], {
    stdio: 'inherit'
  });
  process.exit(result.status || 0);
}
