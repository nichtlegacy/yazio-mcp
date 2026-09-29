const fs = require('fs');
const { version } = require('../package.json');

// Keeps the MCPB manifest in step with package.json on `npm version`.
const file = 'manifest.json';
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`));
