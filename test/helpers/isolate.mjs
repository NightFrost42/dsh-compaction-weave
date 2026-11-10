import fs from 'node:fs';
import path from 'node:path';
const root=process.env.WEAVE_TEST_ROOT;
if(!root)throw new Error('Run the test suite with npm test or npm run test:host.');
for(const name of ['test-tmp','validation','test-results'])fs.mkdirSync(path.join(root,name),{recursive:true});
