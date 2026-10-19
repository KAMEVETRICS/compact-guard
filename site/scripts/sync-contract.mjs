// Copies the compiler's JavaScript output for the registry into site/contract/.
// The site only reads ledger state, and hosts cannot run the Compact compiler,
// so this generated module is committed. Rerun after changing registry.compact:
//   npm run compile -w contracts/registry && npm run sync-contract --prefix site
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;
const from = join(here, '..', '..', 'contracts', 'registry', 'src', 'managed', 'registry', 'contract', 'index.js');
copyFileSync(from, join(here, '..', 'contract', 'index.js'));
console.log('Copied the compiled registry module into site/contract/index.js');
