// Reference source is test material, not an executable React package entry.
import { readFile, writeFile } from 'node:fs/promises';
const sources = {};
for (const file of ['HandoffConsentCard.tsx', 'consentBridge.ts']) {
  sources[file] = await readFile(new URL(`../reference/${file}`, import.meta.url), 'utf8');
}
await writeFile(new URL('../dist/referenceSources.json', import.meta.url), JSON.stringify(sources, null, 2) + '\n');
const openapi = await readFile(new URL('../schemas/openapi.yaml', import.meta.url), 'utf8');
await writeFile(new URL('../dist/openapi.js', import.meta.url), `export default ${JSON.stringify(openapi)};\n`);
await writeFile(new URL('../dist/openapi.d.ts', import.meta.url), 'declare const source: string;\nexport default source;\n');
