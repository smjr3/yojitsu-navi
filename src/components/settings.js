/**
 * 設定画面（SPEC §28）: GitLab 接続（トークン・作成画面へのリンク・接続の確認・デモの立場）と表示（表示モード・テーマカラー、§53）・バージョン情報（§59）
 *
 *   settingsPanel({ masterEdit, fetchImpl }) → HTMLElement
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { ACCESS_LEVELS, checkConnection, effectiveSaveMode, tokenPageUrl, webProjectUrl } from "../core/gitlab.js";
import { clearToken, demoCanMerge, getToken, gitlabFetch, publishMrCount, resetDemo, setDemoCanMerge, setToken, tokenRemembered } from "./gitlab-client.js";
import { infoTip, sectionTitle } from "./layout.js";
import { ACCENTS } from "./appearance.js";

/** ビルド時に head へ入れたバージョン情報（observablehq.config.js の buildInfo）。無い項目は出さない */
export function versionSection(doc = document) {
  const meta = doc.querySelector('meta[name="yn-build"]');
  const rows = [
    [T.settings.version, meta?.dataset.version, "version"],
    [T.settings.commit, meta?.dataset.commit, "commit"],
    [T.settings.builtAt, meta?.dataset.builtAt, "built-at"],
  ].filter(([, v]) => v);
  if (rows.length === 0) return null;
  return html`<section class="yn-settings-section" aria-label=${T.settings.versionTitle} data-role="version">
    ${sectionTitle(T.settings.versionTitle)}
    <dl class="yn-settings-target">${rows.map(([dt, dd, key]) => html`<div><dt>${dt}</dt><dd data-version=${key}><code>${dd}</code></dd></div>`)}</dl>
  </section>`;
}

export function settingsPanel({ masterEdit, fetchImpl = null }) {
  const cfg = masterEdit;
  const demo = cfg.mode === "demo";
  const usable = effectiveSaveMode(cfg) === "gitlab";
  const doFetch = fetchImpl ?? gitlabFetch(cfg);
  const root = html`<div class="yn-settings"></div>`;
  const gitlabSlot = html`<div></div>`;
  const displaySlot = html`<div></div>`;
  /** 接続の確認: null | {busy} | {ok, info} | {error} */
  let check = null;
  let notice = "";

  const focus = (sel) => root.querySelector(sel)?.focus();
  const tokenUrl = tokenPageUrl(cfg);
  const projectUrl = webProjectUrl(cfg);

  /** GitLab のトークン作成画面を新しいタブで開く（名前・scope は入力済み）。デモは開く先が無いので押せない形だけ出す */
  function tokenLink(sm = false) {
    const cls = `yn-btn${sm ? " yn-btn-sm" : ""} yn-settings-token-link`;
    if (tokenUrl === null) {
      return demo ? html`<button type="button" class=${cls} data-role="token-create" disabled title=${T.settings.tokenCreateDemo}>${T.settings.tokenCreate} <span aria-hidden="true">↗</span></button>` : null;
    }
    return html`<a class=${cls} data-role="token-create" href=${tokenUrl} target="_blank" rel="noopener noreferrer" title=${T.settings.tokenCreateTitle}>${T.settings.tokenCreate} <span aria-hidden="true">↗</span></a>`;
  }

  function renderTarget() {
    if (demo) return html`<p class="yn-note yn-note-info" data-role="demo-note">${T.settings.demo}</p>`;
    if (cfg.mode === "download") return html`<p class="yn-note yn-note-warn">${T.settings.downloadMode}</p>`;
    if (!usable) return html`<p class="yn-note yn-note-warn" data-role="not-configured">${T.settings.notConfigured}</p>`;
    return html`<dl class="yn-settings-target" aria-label=${T.settings.target}>
      <div><dt>${T.settings.targetApi}</dt><dd><code>${cfg.gitlab.apiBaseUrl}</code></dd></div>
      <div><dt>${T.settings.targetProject}</dt><dd>${projectUrl
        ? html`<a href=${projectUrl} target="_blank" rel="noopener noreferrer" data-role="project-link" title=${T.settings.openProject}><code>${cfg.gitlab.projectId}</code> <span aria-hidden="true">↗</span></a>`
        : html`<code>${cfg.gitlab.projectId}</code>`}</dd></div>
      <div><dt>${T.settings.targetBranch}</dt><dd><code>${cfg.gitlab.targetBranch}</code></dd></div>
    </dl>`;
  }

  function renderCheck() {
    if (!check) return null;
    if (check.busy) return html`<p class="yn-settings-check is-busy" role="status"><span class="yn-spinner yn-me-spinner" aria-hidden="true"></span> ${T.settings.checking}</p>`;
    if (check.error) {
      return html`<div class="yn-me-outcome is-error" role="alert" tabindex="-1" data-role="check-result"><p class="yn-me-outcome-title"><span aria-hidden="true">!</span> ${T.settings.checkFailed}</p><p>${check.error.message}</p>${check.error.detail ? html`<p class="yn-me-small"><code>${check.error.detail}</code></p>` : null}</div>`;
    }
    const { user, accessLevel, warnings = [] } = check.info;
    const role = accessLevel !== null ? (ACCESS_LEVELS[accessLevel] ?? String(accessLevel)) : T.settings.roleUnknown;
    const canMerge = accessLevel !== null && accessLevel >= 40;
    const canSave = accessLevel === null || accessLevel >= 30;
    const branch = cfg.gitlab.targetBranch;
    return html`<div class=${`yn-me-outcome ${warnings.length ? "is-warn" : "is-ok"}`} role="status" tabindex="-1" data-role="check-result">
      <p class="yn-me-outcome-title"><span aria-hidden="true">✓</span> ${T.settings.checkOk}</p>
      <ul>
        <li>${fmt(T.settings.checkUser, { name: user.name || user.username, username: user.username })}</li>
        <li>${fmt(T.settings.checkRole, { role })}</li>
      </ul>
      <p>${!canSave ? T.settings.cannotSave : canMerge ? T.settings.canMergeYes : T.settings.canMergeNo}</p>
      ${warnings.length
        ? html`<p class="yn-me-outcome-title is-warning" data-role="check-warnings-title"><span aria-hidden="true">!</span> ${fmt(T.settings.warnTitle, { n: warnings.length })}</p>
          <ul class="is-warning" data-role="check-warnings">${warnings.map((w) => html`<li data-warning=${w}>${fmt(T.settings.warn[w] ?? w, { branch })}</li>`)}</ul>`
        : null}
    </div>`;
  }

  async function runCheck() {
    check = { busy: true };
    renderGitlab();
    try {
      check = { info: await checkConnection(doFetch, cfg, getToken()) };
      // GitLab のテーマを配色に使う（§53）
      window.ynAppearance?.setGitlabUser(check.info.appearance);
    } catch (e) {
      check = { error: { message: e?.message ?? String(e), detail: e?.detail ?? "" } };
      if (e?.status === 401) clearToken();
    }
    renderGitlab();
    focus('[data-role="check-result"]');
  }

  function renderToken() {
    const token = getToken();
    if (token !== "") {
      return html`<div class="yn-settings-field">
        <span class="yn-me-label" id="yn-set-token-label">${T.settings.tokenLabel}</span>
        <p class="yn-me-token-set" aria-labelledby="yn-set-token-label"><span class="yn-chip yn-chip-ok"><span aria-hidden="true">✓</span> ${T.settings.tokenSet}</span> <span class="yn-me-small">${tokenRemembered() ? T.settings.tokenWhereLocal : T.settings.tokenWhereSession}</span>
          <button type="button" class="yn-btn yn-btn-sm" data-role="token-clear" onclick=${() => {
            clearToken();
            check = null;
            renderGitlab();
            focus("#yn-set-token");
          }}>${T.settings.tokenClear}</button>${tokenLink(true)}</p>
      </div>`;
    }
    const input = html`<input type="password" id="yn-set-token" class="yn-input" autocomplete="off" spellcheck="false" placeholder=${demo ? "demo" : T.settings.tokenPlaceholder}>`;
    const remember = html`<input type="checkbox" id="yn-set-remember">`;
    const save = () => {
      if (input.value.trim() === "") return input.focus();
      setToken(input.value, remember.checked);
      check = null;
      renderGitlab();
      // 登録したらすぐに接続を確かめる（もう 1 回押させない）
      runCheck();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
    });
    return html`<div class="yn-settings-field">
      <div class="yn-title-with-tip"><label class="yn-me-label" for="yn-set-token">${T.settings.tokenLabel}</label>${infoTip(`${demo ? T.settings.tokenDemoHelp : T.settings.tokenHelp} ${T.settings.rememberHint}`, { label: T.settings.tokenTipLabel })}</div>
      <div class="yn-me-inline">${input}<button type="button" class="yn-btn yn-btn-primary" data-role="token-save" onclick=${save}>${T.settings.tokenSave}</button>${tokenLink()}</div>
      <label class="yn-settings-check-label" for="yn-set-remember">${remember} ${T.settings.remember}</label>
    </div>`;
  }

  function renderDemo() {
    if (!demo) return null;
    const role = html`<input type="checkbox" id="yn-set-demo-role" checked=${demoCanMerge()}>`;
    role.addEventListener("change", () => {
      setDemoCanMerge(role.checked);
      check = null;
      renderGitlab();
      focus("#yn-set-demo-role");
    });
    return html`<div class="yn-settings-field yn-settings-demo">
      <div class="yn-title-with-tip"><label class="yn-settings-check-label" for="yn-set-demo-role">${role} ${T.settings.demoRole}</label>${infoTip(T.settings.demoRoleHint, { label: T.settings.demoRoleTipLabel })}</div>
      <p><button type="button" class="yn-btn yn-btn-sm" data-role="demo-reset" onclick=${() => {
        resetDemo();
        notice = T.settings.demoResetDone;
        renderGitlab();
        focus('[data-role="demo-reset"]');
      }}>${T.settings.demoReset}</button> <span class="yn-me-small" role="status">${notice}</span></p>
    </div>`;
  }

  function renderGitlab() {
    const hasToken = getToken() !== "";
    gitlabSlot.replaceChildren(html`<section class="yn-settings-section" aria-label=${T.settings.gitlabTitle}>
      ${sectionTitle(T.settings.gitlabTitle, T.settings.gitlabHint)}
      ${renderTarget()}
      ${usable
        ? html`${renderToken()}
          <p class="yn-me-actions"><button type="button" class="yn-btn" data-role="check" disabled=${!hasToken || check?.busy} onclick=${runCheck}>${T.settings.check}</button> <a class="yn-settings-link-masters" href="./masters">${T.settings.toMasters}</a></p>
          ${renderCheck()}
          ${renderDemo()}`
        : null}
    </section>`);
  }

  function renderDisplay() {
    const fallback = { theme: "light", accent: "blue", themeFrom: "os", accentFrom: "default" };
    const look = window.ynAppearance?.get() ?? { ...fallback, themePref: "auto", accentPref: "auto", auto: fallback };
    const group = (name, value, items, onPick) =>
      items.map(([v, label, swatch]) => {
        const input = html`<input type="radio" name=${name} value=${v} checked=${value === v}>`;
        input.addEventListener("change", () => {
          if (input.checked) onPick(v);
        });
        return html`<label class="yn-seg-radio">${input}${swatch ? html`<span class="yn-swatch" data-accent=${swatch} aria-hidden="true"></span>` : null}<span>${label}</span></label>`;
      });
    const themes = [
      ["auto", T.settings.auto],
      ["light", T.settings.themes.light],
      ["dark", T.settings.themes.dark],
    ];
    const accents = [
      ["auto", T.settings.auto],
      ...ACCENTS.map((a) => [a, T.settings.accents[a], a]),
    ];
    displaySlot.replaceChildren(html`<section class="yn-settings-section" aria-label=${T.settings.displayTitle}>
      ${sectionTitle(T.settings.displayTitle, T.settings.displayHint)}
      <fieldset class="yn-settings-theme"><legend class="yn-me-label">${T.settings.theme}</legend>${group("yn-set-theme", look.themePref, themes, (v) => window.ynAppearance?.setTheme(v))}</fieldset>
      <fieldset class="yn-settings-theme"><legend class="yn-me-label">${T.settings.accent}</legend>${group("yn-set-accent", look.accentPref, accents, (v) => window.ynAppearance?.setAccent(v))}</fieldset>
    </section>`);
  }

  // 他のタブ・PC の設定・GitLab の読み直しで配色が変わったら、ラジオの選択を合わせる
  window.addEventListener("yn-theme", () => {
    const had = displaySlot.contains(document.activeElement) ? document.activeElement?.getAttribute("name") + ":" + document.activeElement?.getAttribute("value") : null;
    renderDisplay();
    if (had) {
      const [n, v] = had.split(":");
      displaySlot.querySelector(`input[name="${n}"][value="${v}"]`)?.focus();
    }
  });

  renderGitlab();
  renderDisplay();
  root.append(displaySlot, gitlabSlot);
  const version = versionSection();
  if (version) root.append(version);
  if (usable && getToken() === "") publishMrCount(null);
  return root;
}
