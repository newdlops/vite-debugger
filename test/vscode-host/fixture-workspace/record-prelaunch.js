const fs = require('fs');
const path = require('path');

fs.appendFileSync(path.join(__dirname, '.vscode-host-prelaunch-marker'), 'run\n');
