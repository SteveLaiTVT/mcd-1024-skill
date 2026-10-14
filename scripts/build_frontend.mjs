import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Build step for the only remaining web artifact: the terminal receipt card page.
// GitHub Pages serves it at …/mcd-1024-skill/receipt/ (tui/card.mjs CARD_BASE_URL).
// Source: static/receipt-card.html → output/mcd-wheel-static/receipt/index.html.
// A missing source must fail the build loudly: no error swallowing here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'mcd-wheel-static');
await mkdir(path.join(output, 'receipt'), { recursive: true });
await copyFile(path.join(root, 'static', 'receipt-card.html'), path.join(output, 'receipt', 'index.html'));
console.log(`已生成 ${path.relative(root, path.join(output, 'receipt'))}/index.html（小票卡片页）`);
