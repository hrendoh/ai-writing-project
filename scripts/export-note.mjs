#!/usr/bin/env node
// 03_drafts の Zenn 向け Markdown を、note.com のエディタに貼り付けるための HTML に変換する。
// 使い方: node scripts/export-note.mjs 03_drafts/articles/product-quiz.md
// - frontmatter と [REF-xx] / [NOTE-xx] の出典マーカーを除去
// - :::message ブロックは引用（blockquote）に変換
// - 画像は note では貼り付けで入らないため、「【画像: alt（ファイル名）】」の目印に置き換える
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';

const src = process.argv[2];
if (!src) { console.error('使い方: node scripts/export-note.mjs <markdown>'); process.exit(1); }
let md = await readFile(src, 'utf8');

const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
let title = '';
if (fm) { title = (fm[1].match(/^title:\s*"?(.*?)"?\s*$/m) || [,''])[1]; md = md.slice(fm[0].length); }
md = md.replace(/<!--[\s\S]*?-->/g, '');
md = md.replace(/\[(REF|NOTE)-\d+\]/g, '');
md = md.replace(/^:::message\n([\s\S]*?)\n:::$/gm, (_, b) => b.split('\n').map(l => '> ' + l).join('\n'));
md = md.replace(/!\[(.*?)\]\((.*?)\)/g, (_, alt, p) => `**【画像: ${alt}（${path.basename(p)}）】**`);
md = md.replace(/```mermaid[\s\S]*?```/g, '**【図: mermaid（画像に差し替え）】**');

const body = marked.parse(md, { gfm: true, breaks: false });
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
<style>body{max-width:720px;margin:40px auto;font-family:system-ui,sans-serif;line-height:1.8}pre{background:#f4f4f4;padding:12px;overflow:auto}blockquote{border-left:4px solid #ccc;margin:0;padding:4px 16px;color:#444}</style>
</head><body><h1>${title}</h1>
${body}
</body></html>`;
const out = src.replace(/\.md$/, '.note.html');
await writeFile(out, html);
console.log(`書き出し: ${out}`);
