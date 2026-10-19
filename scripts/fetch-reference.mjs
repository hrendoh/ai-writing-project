#!/usr/bin/env node
// 指定URLのページを取得してMarkdown化し、参照文献の抜粋ファイル(REF-xx)と
// 索引(reference_links.md)を自動生成する。画像はローカルに保存する。
//
// 使い方:
//   node scripts/fetch-reference.mjs <URL> [--slug my-slug] [--type 公式Doc] [--full] [--browser]
//
// オプション:
//   --slug  抜粋ファイル名の識別子（省略時はタイトル/ホスト名から自動生成）
//   --type  種別（公式Doc / 仕様 / 技術ブログ / 書籍 など。省略時は「（要確認）」）
//   --full  本文抽出(Readability)をせずページ全体を変換する
//   --browser  ヘッドレスChromeでJavaScript描画後のDOMを取得する（SPAページ向け。
//              Salesforce Help など、通常取得で「Loading」しか返らない場合に使う。
//              Chrome は環境変数 CHROME_PATH、Google Chrome、Playwright 導入済みブラウザの順に探す）
//
// GitHub の非公開リポジトリ (github.com/<owner>/<repo>[/blob/<ref>/<path>]) は HTTP で取得
// できないため、404 のときは `gh api` で中身を取得する（gh auth login 済みであること）。

import { readdir, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const execFileP = promisify(execFile);

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SOURCES_DIR = path.join(REPO_ROOT, '01_sources');
const REFERENCES_DIR = path.join(SOURCES_DIR, 'references');
const INDEX_FILE = path.join(SOURCES_DIR, 'reference_links.md');

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- 引数パース ------------------------------------------------------------
function parseArgs(argv) {
  const opts = { url: null, slug: null, type: null, full: false, browser: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') opts.full = true;
    else if (a === '--browser') opts.browser = true;
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a === '--type') opts.type = argv[++i];
    else if (a.startsWith('--')) fail(`不明なオプション: ${a}`);
    else if (!opts.url) opts.url = a;
    else fail(`引数が多すぎます: ${a}`);
  }
  if (!opts.url) fail('URLを指定してください。\n  例: node scripts/fetch-reference.mjs https://example.com/docs');
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
async function nextRefId() {
  let max = 0;
  let entries = [];
  try {
    entries = await readdir(REFERENCES_DIR);
  } catch {
    /* ディレクトリ未作成なら 0 から */
  }
  for (const name of entries) {
    const m = name.match(/^REF-(\d+)_/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  try {
    const index = await readFile(INDEX_FILE, 'utf8');
    for (const m of index.matchAll(/REF-(\d+)/g)) {
      max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    /* 索引が無ければスキップ */
  }
  return `REF-${String(max + 1).padStart(2, '0')}`;
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
    if (!res.ok) {
      if (res.status === 404 && parseGithubUrl(url)) return null; // gh api にフォールバック
      fail(`取得失敗 (HTTP ${res.status}): ${url}`);
    }
    return await res.text();
  } catch (e) {
    if (e?.name === 'AbortError') fail(`タイムアウト (${FETCH_TIMEOUT_MS}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---- GitHub 非公開リポジトリ (gh api) -------------------------------------
// github.com/<owner>/<repo> はリポジトリの README、
// github.com/<owner>/<repo>/blob/<ref>/<path> はそのファイルを指すものとして扱う。
function parseGithubUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  const [owner, repo] = seg;
  if (seg.length === 2) return { owner, repo, ref: null, path: 'README.md' };
  if (seg[2] === 'blob' && seg.length >= 5) {
    return { owner, repo, ref: seg[3], path: seg.slice(4).join('/') };
  }
  return null;
}

function ghApi(endpoint, jq) {
  const args = ['api', endpoint];
  if (jq) args.push('--jq', jq);
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim();
    fail(`gh api に失敗しました (${endpoint}): ${msg}\n  gh がインストール済みで gh auth login 済みか確認してください。`);
  }
}

// gh api でファイル本文を取得し、Markdown 化済みのテキストとタイトルを返す。
// Markdown ファイルはそのまま、それ以外は拡張子を言語としたコードブロックにする。
function fetchGithubFileAsMarkdown(gh) {
  const q = gh.ref ? `?ref=${encodeURIComponent(gh.ref)}` : '';
  const b64 = ghApi(`repos/${gh.owner}/${gh.repo}/contents/${gh.path}${q}`, '.content');
  const text = Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8');
  const ext = path.extname(gh.path).replace('.', '').toLowerCase();
  const title = `${gh.owner}/${gh.repo}: ${gh.path}`;
  if (ext === 'md' || ext === 'markdown') return { title, markdown: text.trim() };
  return { title, markdown: `\`\`\`${ext}\n${text.replace(/\n+$/, '')}\n\`\`\`` };
}

// ---- ヘッドレス Chrome による描画 (--browser) -------------------------------
// ヘッドレスChromeでJS描画後のDOMを取得する
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

// Playwright がインストールした軽量ブラウザ（chrome-headless-shell）も候補に加える。
// フル版 Chrome が dump-dom 後に終了しない環境でも、こちらは確実に終了する。
async function playwrightChromeCandidates() {
  const pw = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const found = [];
  try {
    const dirs = (await readdir(pw)).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const d of dirs) {
      for (const arch of ['mac-arm64', 'mac-x64', 'linux']) {
        found.push(path.join(pw, d, `chrome-headless-shell-${arch}`, 'chrome-headless-shell'));
      }
    }
  } catch {
    /* Playwright 未導入 */
  }
  return found;
}

async function fetchWithBrowser(url) {
  let chrome = null;
  for (const c of [...CHROME_CANDIDATES, ...(await playwrightChromeCandidates())]) {
    try { await access(c); chrome = c; break; } catch {}
  }
  if (!chrome) fail('Chrome が見つかりません。CHROME_PATH 環境変数で指定してください。');
  const profile = path.join(os.tmpdir(), 'fetch-reference-chrome-profile');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=20000', '--timeout=60000',
    '--dump-dom', url,
  ];
  const { stdout } = await execFileP(chrome, args, { maxBuffer: 64 * 1024 * 1024 });
  if (!stdout.trim()) fail(`ヘッドレスChromeが空のDOMを返しました: ${url}`);
  return stdout;
}

// ---- 画像保存 --------------------------------------------------------------
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

async function downloadImages(doc, baseUrl, refId, assetsDir) {
  const imgs = [...doc.querySelectorAll('img')];
  if (imgs.length === 0) return 0;
  await mkdir(assetsDir, { recursive: true });

  let saved = 0;
  let n = 0;
  for (const img of imgs) {
    const raw =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      '';
    if (!raw || raw.startsWith('data:')) continue;

    let absUrl;
    try {
      absUrl = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    n++;
    try {
      const res = await fetch(absUrl, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
      let ext = EXT_BY_MIME[mime];
      if (!ext) ext = path.extname(new URL(absUrl).pathname).replace('.', '') || 'img';
      const filename = `img-${String(n).padStart(2, '0')}.${ext}`;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(path.join(assetsDir, filename), buf);
      // md ファイル(references/)から見た相対パス。元URLは title に残す。
      img.setAttribute('src', `assets/${refId}/${filename}`);
      img.setAttribute('title', `orig: ${absUrl}`);
      saved++;
    } catch (e) {
      console.warn(`  画像取得失敗 (元URLのまま残します): ${absUrl} -- ${e.message}`);
      img.setAttribute('src', absUrl); // 絶対URLに正規化だけしておく
    }
  }
  return saved;
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
// サイトによって言語の付け方が異なる（language-xxx / lang-xxx / brush: xxx /
// highlight-source-xxx / data-language 等）ため、よくあるパターンから推測する。
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

// ---- 索引更新 --------------------------------------------------------------
function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

async function appendToIndex({ refId, title, url, type, date, mdFilename }) {
  let content;
  try {
    content = await readFile(INDEX_FILE, 'utf8');
  } catch {
    fail(`索引ファイルが見つかりません: ${INDEX_FILE}`);
  }
  const row =
    `| ${refId} | ${escapeCell(title)} | ${url} | ${type} | ${date} ` +
    `| [${refId}](references/${mdFilename}) |`;

  const lines = content.split('\n');
  let lastTableLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('|')) lastTableLine = i;
  }
  if (lastTableLine === -1) fail('索引内に表が見つかりませんでした。reference_links.md の表を確認してください。');
  lines.splice(lastTableLine + 1, 0, row);
  await writeFile(INDEX_FILE, lines.join('\n'));
}

// ---- 抜粋ファイル生成 ------------------------------------------------------
function buildRefFile({ refId, title, url, date, type, markdown, via }) {
  const viaLine = via ? `\n- 取得方法: ${via}` : '';
  return `# ${refId}: ${title}

- URL: ${url}
- 取得日: ${date}
- 種別: ${type}${viaLine}

## 記事で使う事実（要約）
- （この文献から記事の根拠として使う事実を、下の「原文」を読んで箇条書きで記入する）

## 原文（自動取得）
<!-- ${url} を ${date} に自動取得${via ? `（${via}）` : ''}・Markdown化したもの。画像は assets/${refId}/ に保存。 -->

${markdown}
`;
}

// ---- メイン ----------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const date = new Date().toISOString().slice(0, 10);

  console.log(`取得中: ${opts.url}`);
  let html = null;
  let ghFile = null;
  if (opts.browser) {
    html = await fetchWithBrowser(opts.url);
  } else {
    html = await fetchText(opts.url);
    if (html === null) {
      const gh = parseGithubUrl(opts.url);
      console.log(`  HTTP 404 のため gh api で取得します: ${gh.owner}/${gh.repo} ${gh.path}`);
      ghFile = fetchGithubFileAsMarkdown(gh);
    }
  }

  if (ghFile) {
    const refId = await nextRefId();
    const slug = opts.slug ? slugify(opts.slug, opts.url) : slugify(ghFile.title, opts.url);
    const mdFilename = `${refId}_${slug || 'page'}.md`;
    const type = opts.type || 'リポジトリ内ファイル';
    await mkdir(REFERENCES_DIR, { recursive: true });
    await writeFile(
      path.join(REFERENCES_DIR, mdFilename),
      buildRefFile({ refId, title: ghFile.title, url: opts.url, date, type, markdown: ghFile.markdown, via: 'gh api' }),
    );
    await appendToIndex({ refId, title: ghFile.title, url: opts.url, type, date, mdFilename });
    console.log(`\n完了: ${refId}`);
    console.log(`  抜粋ファイル: 01_sources/references/${mdFilename}`);
    console.log(`  索引: 01_sources/reference_links.md に追記`);
    console.log(`\n次のステップ: 「${refId} の要約を埋めて」と依頼するか、手動で「記事で使う事実（要約）」を記入してください。`);
    return;
  }

  const dom = new JSDOM(html, { url: opts.url });
  const docTitle = dom.window.document.title || '';

  // 本文DOMと、Markdown化前のタイトルを決める
  let contentDoc;
  let title = docTitle;
  if (opts.full) {
    contentDoc = dom.window.document;
  } else {
    // keepClasses: コードブロックの言語(class="brush: js" 等)を残して言語検出に使う
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

  const refId = await nextRefId();
  const slug = opts.slug ? slugify(opts.slug, opts.url) : slugify(title, opts.url);
  const mdFilename = `${refId}_${slug || 'page'}.md`;
  const type = opts.type || '（要確認）';

  await mkdir(REFERENCES_DIR, { recursive: true });
  const assetsDir = path.join(REFERENCES_DIR, 'assets', refId);
  const savedImages = await downloadImages(contentDoc, opts.url, refId, assetsDir);

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);
  addFencedCodeRule(turndown);
  const markdown = turndown.turndown(contentDoc.body.innerHTML).trim();

  const refPath = path.join(REFERENCES_DIR, mdFilename);
  await writeFile(refPath, buildRefFile({ refId, title, url: opts.url, date, type, markdown, via: opts.browser ? 'ヘッドレス Chrome で描画' : undefined }));

  await appendToIndex({ refId, title, url: opts.url, type, date, mdFilename });

  console.log(`\n完了: ${refId}`);
  console.log(`  抜粋ファイル: 01_sources/references/${mdFilename}`);
  if (savedImages > 0) console.log(`  画像: 01_sources/references/assets/${refId}/ に ${savedImages} 件保存`);
  console.log(`  索引: 01_sources/reference_links.md に追記`);
  console.log(`\n次のステップ: 「${refId} の要約を埋めて」と依頼するか、手動で「記事で使う事実（要約）」を記入してください。`);
}

// 他スクリプト（fetch-repo-reference.mjs など）から部品を再利用できるように公開する
export { nextRefId, appendToIndex, buildRefFile, slugify, ghApi, parseGithubUrl, fetchGithubFileAsMarkdown, REFERENCES_DIR };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
