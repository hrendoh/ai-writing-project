# AI執筆エージェント プロジェクトテンプレート

このプロジェクトは、Claude CodeなどのAIコーディングエージェントを活用して、ハルシネーションを抑えながら正確な記事を執筆するためのディレクトリ構成テンプレートです。

## 使い方
1. `01_sources/raw_notes.md` に、書きたい内容のメモやソースコードなどを自由に配置します（整理されていなくてOK）。溜まってきたら「raw_notes を整理して」と指示すると、AIが1検証・1トピックごとに `01_sources/notes/NOTE-xx` へ分割・索引化します（構造化は著者ではなくAIの仕事です）。
2. Claude Codeを起動し、「メモをもとに `02_outlines/toc.md` の構成案を一緒に作って」と指示します。この時点で参照文献は不要です。根拠が必要な記述には AI が `🔍 要出典:` マーカーを付け、「どんな根拠があれば書けるか」を明示します。
3. 構成に合意したら、「要出典を調査して」と指示します。外部文献で裏付けるものはAIが候補URLを探して提案するので、採用するものを選ぶと `references/REF-xx` として取り込まれます。自分で検証して裏付けるものは、検証結果をメモに貼れば `notes/NOTE-xx` として整理されます。裏付けが取れた要出典は `toc.md` 上で `[REF-xx]` / `[NOTE-xx]` に置き換わり、根拠が見つからなかった記述は、削除するか「経験談」として書くかをこの時点で決めます。
4. すべての要出典が解消したら、「1章ずつ `03_drafts/` に執筆して」と指示し、AIに質問させながら進めます。

> **ポイント**: 先に構成（仮説）を固めてから調査を始めることで、「何を参照文献としてキュレーションすべきか」が構成から逆算できる有限のTODOリストになります。執筆の根拠に使えるのは `01_sources/` に整理された抜粋（`REF-xx`）と検証メモ（`NOTE-xx`）のみ、という原則は変わりません。

## 検証メモの管理（`01_sources/notes/`）
自分で手を動かして確認した事実（実験ログ、コード出力、動作確認など）は、`notes/NOTE-xx_*.md` に1検証・1トピックで整理し、`note_links.md` で索引管理します。原稿や構成案からは `[NOTE-01]` の形式で出典を示します。

- `raw_notes.md` はインボックス（一時置き場）です。整理せず書き殴ってOK。分割・索引化はAIに依頼できます（AIは原文の転記のみを行い、内容の創作はしません）。
- 外部の文献が根拠の場合は `NOTE-xx` ではなく、下記の `REF-xx` を使います。

## 参照文献の管理（`01_sources/`）
公式ドキュメントや技術記事を記事の根拠として使うときは、`references/REF-xx_*.md` に内容を抜粋して残します。

> **なぜ抜粋が必要か**: AIは `01_sources/` に書かれた情報しか使えません。URLを貼るだけでは中身を事実として扱えない（推測で補完するのは禁止）ため、必ず `references/` に事実を書き写してください。

### おすすめ: スクリプトで自動取得する
指定URLのページをMarkdown化し、抜粋ファイル（`REF-xx`）の生成・索引（`reference_links.md`）への追記・**画像のローカル保存**まで自動で行えます。

```bash
# 初回のみ依存をインストール
cd scripts && npm install && cd ..

# URLを取得して REF-xx を生成
node scripts/fetch-reference.mjs <URL> [--type 公式Doc] [--slug 任意のID名] [--full] [--browser]
```

- 本文だけを抽出（ナビ・広告等を除去）し、コードブロック（言語付き）・表・画像を保持します。`--full` でページ全体を変換。
- 画像は `01_sources/references/assets/REF-xx/` に保存され、AIが内容を確認できます（URLリンクのままだとAIは画像を閲覧できません）。
- 生成後、`REF-xx` ファイルの「記事で使う事実（要約）」は空です。内容を読んで記入するか、Claudeに「`REF-xx` の要約を埋めて」と依頼してください。
- JavaScriptで描画するページ（SPA）は `--browser` を付けるとヘッドレスChrome（`/Applications/Google Chrome.app`、または `CHROME_PATH`）で描画後のDOMを取得します。Salesforce Help のリリースノートはこのオプションが必要で、URLに `release=26x` を付けないと空ページになります。ログインが必要なページは取得できません。

### 手動で追加する場合
1. `01_sources/references/REF-00_example.md` をコピーして `REF-xx_スラッグ.md` を作り、URLから**記事の根拠になる事実と原文引用**を書き写します。
2. `01_sources/reference_links.md` の一覧表に1行追加し、`REF-01` から連番でIDを振ります。
3. 原稿や構成案では `[REF-01]` の形式で出典を示します。

## 補助ライティングスキルの導入（任意）
執筆・推敲の品質を上げる補助として、k16shikano氏作の2つのライティングスキルを利用できます。

- `japanese-tech-writing`: 日本語技術文書の文章規範（論証の厳密さ、LLMっぽい空句の禁止、冗長の排除など）
  https://gist.github.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d
- `cognitive-rhythm-writing`: 説明的な文章に緩急を設計するための規範
  https://gist.github.com/k16shikano/eb2929f13ed19c97188393d297be8432

導入する場合は、以下のコマンドで各gistの `SKILL.md` を `.claude/skills/` に配置します。

```bash
mkdir -p .claude/skills/japanese-tech-writing .claude/skills/cognitive-rhythm-writing
curl -sL -o .claude/skills/japanese-tech-writing/SKILL.md \
  https://gist.githubusercontent.com/k16shikano/fd287c3133457c4fd8f5601d34aa817d/raw/SKILL.md
curl -sL -o .claude/skills/cognitive-rhythm-writing/SKILL.md \
  https://gist.githubusercontent.com/k16shikano/eb2929f13ed19c97188393d297be8432/raw/SKILL.md
```

- スキル本体は第三者の著作物のためリポジトリにはコミットしません（`.claude/skills/` は `.gitignore` 済み）。
- スキルと `00_rules/` のルールが衝突した場合の優先順位・解決方法は `00_rules/writing_guidelines.md` の「4. 補助スキルとの併用ルール」に定めています。

## note.com への書き出し

Zenn 向けの原稿を note のエディタに貼り付けるための HTML に変換します。

```bash
node scripts/export-note.mjs 03_drafts/articles/<記事>.md
```

`<記事>.note.html` が隣に生成されます。frontmatter と `[REF-xx]` / `[NOTE-xx]` の出典マーカーは除去され、`:::message` は引用に、画像は「【画像: …】」の目印に置き換わります。生成した HTML をブラウザで開いて全選択・コピーし、note の記事に貼り付けたあと、目印の位置に `images/` の画像をドラッグ＆ドロップしてください。
