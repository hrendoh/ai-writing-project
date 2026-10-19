#!/usr/bin/env node
// GitHub リポジトリ内の複数ファイルとコミット履歴を、まとめて1つの参照文献(REF-xx)として取り込む。
// 非公開リポジトリでも `gh api` で取得する（gh auth login 済みであること）。
//
// 使い方:
//   node scripts/fetch-repo-reference.mjs <owner>/<repo> [path ...] [--ref main] [--commits 30] [--slug my-slug] [--type 種別]
//
// 例:
//   node scripts/fetch-repo-reference.mjs co-meeting/product-quiz README.md docs/design.md --commits 50
//
// オプション:
//   path       取り込むファイル（省略時は README.md）。Markdown はそのまま、それ以外は拡張子を言語にしたコードブロックで収録
//   --ref      ブランチ/タグ/コミット（省略時はデフォルトブランチ）
//   --commits  コミット履歴を新しい順に N 件収録（日付と件名）。省略時は収録しない
//   --slug     抜粋ファイル名の識別子（省略時は <owner>-<repo>）
//   --type     種別（省略時は「リポジトリ実データ」）
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nextRefId,
  appendToIndex,
  buildRefFile,
  slugify,
  ghApi,
  fetchGithubFileAsMarkdown,
  REFERENCES_DIR,
} from './fetch-reference.mjs';

function fail(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { repo: null, paths: [], ref: null, commits: 0, slug: null, type: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--commits') opts.commits = parseInt(argv[++i], 10) || 0;
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a === '--type') opts.type = argv[++i];
    else if (a.startsWith('--')) fail(`不明なオプション: ${a}`);
    else if (!opts.repo) opts.repo = a;
    else opts.paths.push(a);
  }
  if (!opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    fail('<owner>/<repo> を指定してください。\n  例: node scripts/fetch-repo-reference.mjs co-meeting/product-quiz README.md docs/design.md');
  }
  if (opts.paths.length === 0) opts.paths = ['README.md'];
  return opts;
}

function fetchCommits(owner, repo, ref, n) {
  const q = new URLSearchParams({ per_page: String(Math.min(n, 100)) });
  if (ref) q.set('sha', ref);
  const out = ghApi(
    `repos/${owner}/${repo}/commits?${q}`,
    '.[] | .commit.author.date[:10] + " " + (.commit.message | split("\n")[0])',
  );
  return out.trim();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [owner, repo] = opts.repo.split('/');
  const date = new Date().toISOString().slice(0, 10);
  const url = `https://github.com/${owner}/${repo}`;

  const sections = [];
  for (const p of opts.paths) {
    console.log(`取得中: ${opts.repo} ${p}`);
    const { markdown } = fetchGithubFileAsMarkdown({ owner, repo, ref: opts.ref, path: p });
    const fileUrl = `${url}/blob/${opts.ref || 'HEAD'}/${p}`;
    sections.push(`### ${p}\n\n<!-- ${fileUrl} -->\n\n${markdown}`);
  }
  if (opts.commits > 0) {
    console.log(`取得中: コミット履歴 ${opts.commits} 件`);
    const log = fetchCommits(owner, repo, opts.ref, opts.commits);
    sections.push(`### コミット履歴（新しい順、日付と件名）\n\n\`\`\`text\n${log}\n\`\`\``);
  }

  const refId = await nextRefId();
  const title = `${opts.repo} リポジトリ抜粋（${opts.paths.join(', ')}${opts.commits ? ', コミット履歴' : ''}）`;
  const slug = slugify(opts.slug || `${owner}-${repo}`, url);
  const mdFilename = `${refId}_${slug || 'repo'}.md`;
  const type = opts.type || 'リポジトリ実データ';

  await mkdir(REFERENCES_DIR, { recursive: true });
  await writeFile(
    path.join(REFERENCES_DIR, mdFilename),
    buildRefFile({ refId, title, url, date, type, markdown: sections.join('\n\n'), via: `gh api（ref: ${opts.ref || 'default branch'}）` }),
  );
  await appendToIndex({ refId, title, url, type, date, mdFilename });

  console.log(`\n完了: ${refId}`);
  console.log(`  抜粋ファイル: 01_sources/references/${mdFilename}`);
  console.log(`  索引: 01_sources/reference_links.md に追記`);
  console.log(`\n次のステップ: 「${refId} の要約を埋めて」と依頼するか、手動で「記事で使う事実（要約）」を記入してください。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
