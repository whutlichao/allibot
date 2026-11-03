import { mkdir, writeFile } from 'node:fs/promises';

const distDir = new URL('../dist/', import.meta.url);

const wrapper = `#!/usr/bin/env node
import { main } from '../server/dist/cli.js';

process.exitCode = await main(process.argv.slice(2));
`;

await mkdir(distDir, { recursive: true });
await writeFile(new URL('cli.js', distDir), wrapper, 'utf8');
