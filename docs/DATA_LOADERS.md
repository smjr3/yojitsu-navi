# データローダとキャッシュの決まり

画面のデータは Observable Framework のデータローダ（`src/data/*.json.ts` など）がビルド時に作ります。
ローダの出力は `src/.observablehq/cache/` にキャッシュされるため、何もしないと次のような壊れ方をします。

- `observable build` は古いキャッシュをそのまま使う。`data/*.csv` を直してもローダのファイル自体が変わらないので、**古い数字のまま公開される**
- ローダが途中で落ちると、書きかけのファイルや `.err` が残る
- ローダが `console.log` で出した文字が出力に混ざる、NaN や空の出力がそのまま配信される

これを防ぐため、次の決まりで作っています。新しいローダを足すときもこのとおりにしてください。

## 1. 入力の指紋で古いキャッシュを捨てる（`scripts/lib/inputs.ts`・`loader-cache.ts`）

- ローダの入力（`data/`・`config.json`・`package-lock.json`・`src/core`・`src/data`・`src/i18n`・`scripts/lib`・`scripts/adapters` など。一覧は `INPUT_PATHS`）と計算基準日（`YOJITSU_AS_OF`、無ければ今日の JST。画面ではさらに開いた人の今日に置き換える。SPEC §75）・固定したか（`YOJITSU_AS_OF_FIXED`）・git の HEAD・GitLab の接続先の環境変数（`YOJITSU_GITLAB_*`。SPEC §39.1）から sha256 の指紋を作る。
- 指紋は「データ」（`data/`・`config.json`）と「プログラム」（それ以外）に分けても取る（`codeHash`）。`npm run build`（`scripts/build.ts`）と `npm run dev`（`scripts/dev.ts`）は、前回の記録（`src/.observablehq/cache/.yojitsu-inputs.json`）とプログラムの指紋が違えばキャッシュを丸ごと消し（フルビルド）、データだけが違えば依存ライブラリの束（`_node/`・`_observablehq/`）を残して消す（`npm run build` はローダの出力も残し、下の 6. で変わったものだけ書き換える）。`YOJITSU_FULL_BUILD=1` なら必ず丸ごと消す。
  - 同じ指紋でも、書きかけのファイル（`*.tmp-*`・`*.json.<pid>`）と失敗の印（`*.err`）は毎回消す。
  - `npm run dev` は入力を監視し、変わればキャッシュを消してローダを作り直させる（画面の再読み込みで新しい数字になる）。
- **`npx observable build` を直接叩かない**（指紋の確認も検証も通らない）。必ず `npm run build`。

## 2. ローダは「全部出すか、何も出さないか」（`src/data/_shared.ts`）

- 出力は `emitJson(() => 値)` / `emitText(() => 文字列)` で書く。中で例外が出たら何も書かずに **終了コード 1** で止まる（ビルドも止まる）。
- 書く前に `findInvalidJsonValue` で NaN・±Infinity・`undefined`・関数・循環参照を探し、見つかれば場所（`contracts[3].budget` など）を付けて失敗する。空の出力も失敗。
- `console.log` / `console.info` は標準エラーに回す（出力に混ざらない）。ログは標準エラーへ。
- JSON の出力には `_build: { inputHash, asOf }` を付ける（作業ログ明細だけは `{ asOf }`。下の 6.）。
- 出力の中身は `src/data/_outputs.ts` に書き、ローダはそれを呼ぶだけにする（`npm run build` がまとめて作るため）。新しいローダは `AGGREGATE_OUTPUTS` にも足す。

## 3. ビルド結果を検証してから公開（`scripts/verify-dist.ts`）

`npm run build` は最後に `dist/` を検証し、1 つでも合わなければ **`dist/` を消して** 失敗します（古い・壊れたサイトを公開しない）。

- `index.html` があり、`_file/data/*.json` がすべて読めて、`_build` の指紋・基準日が今回のものと一致する
- ローダの出力の記録（`src/.observablehq/cache/.yojitsu-outputs.json`）が今回の指紋のもので、`dist/` の各出力の中身（sha256）が記録と一致する
- 必須の出力（`model`・`member-months`・`masters`・`dataset-issues`・`daily`）がちょうど 1 つずつある
- `model` の契約数が `contracts.csv` と一致し、作業ログ（`dist/data/worklogs/<契約ID>.json`）が契約ごとに 1 つずつある
- ビルド中に入力が変わっていない（ビルド後に指紋を取り直して比べる）

単体でも `npm run verify:dist` で実行できます。キャッシュを使ったビルドが検証で落ちたら、`npm run build` は 1 回だけフルビルドでやり直します（それでも落ちたら `dist/` を消して失敗）。

## 4. ファイルは一時ファイルに書いてから置き換える（`scripts/lib/atomic.ts`）

`npm run fetch`・`npm run fetch:members`・`npm run fetch:projects` など `data/` を書き換えるスクリプトは `writeFileAtomic` / `writeFilesAtomic` を使います。
一時ファイル（`<名前>.tmp-<pid>-<乱数>`）に書いて fsync し、**全部書けてから** 名前を置き換えるので、途中で落ちても元のファイルは壊れません。

## 5. 作業ログのローダ（`src/data/worklogs/[contractId].json.js`）

契約ごとのファイルは数が多い（5 倍データで 100 件超）ので、1 回の計算で全契約分を作り、指紋ごとのフォルダ（`src/.observablehq/cache/.yojitsu/worklogs-<指紋>/`）に置いて使い回します。
フォルダは一時フォルダに全部書いて `.complete` を置いてから名前を変えるので、半端な中身は使われません。
名前の変更に失敗したとき、別のプロセスが同じフォルダを置き終えていた（`.complete` がある）場合だけこちらを捨てて続け、それ以外は止めます（黙って続けない）。Windows で一時的に起きる失敗（`EPERM`・`EACCES`・`EBUSY`）は少し待ってやり直します（SPEC §79.1）。
ローダ本体は TypeScript のコンパイルを避けるため素の JS（メモが無いときだけ `_worklog-memo.ts` を起動）。
`npm run build` では下の 6. が先に全契約分をキャッシュに置くので、このローダは動きません（`npm run dev`・単体実行のときだけ使う）。

ファイル名にハッシュが付かないため、画面は `fetch(..., { cache: "no-cache" })` で読みます（古い作業ログを表示しない）。

## 6. 増分ビルド（`scripts/prebuild-data.ts`・`scripts/lib/prebuild.ts`。SPEC §102）

`npm run build` は `observable build` の前に、全ローダの出力を **1 つのプロセスで** 作ります（データの読み込みと Model の計算は 1 回）。

- キャッシュ（`src/.observablehq/cache/data/`）の中身と比べ、変わったファイルだけを書き換える。作るべき出力に無いファイル（消えた契約の明細・失敗の記録・知らない出力）は消す
- 作業ログ明細は入力の指紋を持たないので、データのほかの所が変わっても、その契約の明細が同じなら書き換わらない
- 各出力の sha256 を記録（`.yojitsu-outputs.json`）に書く。記録は作り始めに消し、全部書けてから書く（途中で失敗したら次のビルドは必ず作り直す）。前回の記録が今の指紋のものなら作り直さない
- キャッシュに出力があるので、`observable build` はローダを動かさずにそれを使う

CI では `build` ジョブの `cache:` で `src/.observablehq/cache/` を使い回します（`.gitlab-ci.yml`）。壊れた・古いキャッシュが戻っても、指紋と記録で確かめて作り直すので古い数字は公開されません。

## テスト

- `tests/unit/loader-integrity.test.ts`: 指紋・キャッシュの消去・原子的な書き込み・不正な値の検出・dist の検証
- `tests/integration/loaders.test.ts`: 実際のローダを起動し、失敗時に非 0 で終わり何も出さないこと、標準出力が JSON だけであること
- `tests/integration/incremental-build.test.ts`: まとめて作る・変わったものだけ書き換える・影響のある契約の明細だけ・消えたものを消す・ローダとの対応
