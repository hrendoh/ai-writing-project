#!/usr/bin/env node
// 文体トーン抽出用のサンプル記事を取得してMarkdown化し、
// 00_rules/style_samples/ に保存する。
//
// サンプル記事は著作物のコピーのためリポジトリにはコミットしない
// （00_rules/style_samples/ は .gitignore 済み）。
// 抽出の手順は 00_rules/style_extraction_procedure.md を参照。
//
// 使い方:
//   node scripts/fetch-style-sample.mjs <URL> [--slug my-slug] [--full]
//
// オプション:
//   --slug  ファイル名の識別子（省略時はタイトル/ホスト名から自動生成）
//   --full  本文抽出(Readability)をせずページ全体を変換する

import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SAMPLES_DIR = path.join(REPO_ROOT, '00_rules', 'style_samples');

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- 引数パース ------------------------------------------------------------
function parseArgs(argv) {
  const opts = { url: null, slug: null, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') opts.full = true;
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a.startsWith('--')) fail(`不明なオプション: ${a}`);
    else if (!opts.url) opts.url = a;
    else fail(`引数が多すぎます: ${a}`);
  }
  if (!opts.url) fail('URLを指定してください。\n  例: node scripts/fetch-style-sample.mjs https://example.com/article');
  try {
    new URL(opts.url);
  } catch {
    fail(`URLが不正です: ${opts.url}`);
  }
  return opts;
}

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}

// ---- ID採番 ----------------------------------------------------------------
async function nextSampleId() {
  let max = 0;
  let entries = [];
  try {
    entries = await readdir(SAMPLES_DIR);
  } catch {
    /* ディレクトリ未作成なら 0 から */
  }
  for (const name of entries) {
    const m = name.match(/^SAMPLE-(\d+)_/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `SAMPLE-${String(max + 1).padStart(2, '0')}`;
}

// ---- 取得 ------------------------------------------------------------------
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) fail(`取得失敗 (HTTP ${res.status}): ${url}`);
    return await res.text();
  } catch (e) {
    if (e?.name === 'AbortError') fail(`タイムアウト (${FETCH_TIMEOUT_MS}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---- slug 生成 -------------------------------------------------------------
function slugify(title, url) {
  const fromTitle = (title || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  if (fromTitle) return fromTitle;
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '').replace(/\./g, '-');
  const seg = u.pathname.split('/').filter(Boolean).pop() || '';
  const tail = seg.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [host, tail].filter(Boolean).join('-').slice(0, 50);
}

// ---- コードブロックの言語検出 ----------------------------------------------
function detectLang(el) {
  if (!el || !el.getAttribute) return '';
  const cls = el.getAttribute('class') || '';
  const patterns = [
    /(?:^|\s)language-([\w+#-]+)/i,
    /(?:^|\s)lang-([\w+#-]+)/i,
    /brush:\s*([\w+#-]+)/i,
    /highlight-source-([\w+#-]+)/i,
    /(?:^|\s)hljs[- ]([\w+#-]+)/i,
  ];
  for (const re of patterns) {
    const m = cls.match(re);
    if (m && !['notranslate', 'hljs', 'highlight'].includes(m[1].toLowerCase())) return m[1];
  }
  return el.getAttribute('data-language') || el.getAttribute('data-lang') || '';
}

function addFencedCodeRule(turndown) {
  turndown.addRule('fencedCodeWithLang', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const codeEl = node.querySelector('code') || node;
      const lang = detectLang(node) || detectLang(codeEl) || '';
      const code = codeEl.textContent.replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    },
  });
}

// ---- メイン ----------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const date = new Date().toISOString().slice(0, 10);

  console.log(`取得中: ${opts.url}`);
  const html = await fetchText(opts.url);

  const dom = new JSDOM(html, { url: opts.url });
  const docTitle = dom.window.document.title || '';

  let contentDoc;
  let title = docTitle;
  if (opts.full) {
    contentDoc = dom.window.document;
  } else {
    const article = new Readability(dom.window.document, { keepClasses: true }).parse();
    if (!article || !article.content) {
      console.warn('  本文抽出に失敗したため、ページ全体を変換します（--full 相当）。');
      contentDoc = new JSDOM(html, { url: opts.url }).window.document;
    } else {
      title = article.title || docTitle;
      contentDoc = new JSDOM(article.content, { url: opts.url }).window.document;
    }
  }
  title = (title || opts.url).trim();

  const sampleId = await nextSampleId();
  const slug = opts.slug ? slugify(opts.slug, opts.url) : slugify(title, opts.url);
  const mdFilename = `${sampleId}_${slug || 'article'}.md`;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);
  addFencedCodeRule(turndown);
  const markdown = turndown.turndown(contentDoc.body.innerHTML).trim();

  await mkdir(SAMPLES_DIR, { recursive: true });
  const samplePath = path.join(SAMPLES_DIR, mdFilename);
  await writeFile(
    samplePath,
    `# ${sampleId}: ${title}

- URL: ${opts.url}
- 取得日: ${date}

## 原文（自動取得・文体分析用）
<!-- リポジトリにはコミットしない（.gitignore 済み） -->

${markdown}
`
  );

  console.log(`\n完了: ${sampleId}`);
  console.log(`  保存先: 00_rules/style_samples/${mdFilename}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
