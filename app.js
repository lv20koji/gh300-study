"use strict";
/* GH-300 勉強アプリ（Web版）
   iOS版（SwiftUI）と同一の設計・データ形式・SRSルールで動作する。
   - 問題バンク: questions.json（iOS版と同一ファイル形式）
   - 進捗: localStorage（iOS版のSwiftData QuestionProgress / StudySession に対応）
   - SRS: SM-2方式。Swift版 SRS.swift と計算式・挙動を一致させている
   - 書き出し/読み込み: iOS版 ExportPayload と同一スキーマ */

// ============================================================
// 定数
// ============================================================
const DOMAIN_NAMES = {
  1: "責任あるGitHub Copilotの利用",
  2: "GitHub Copilotの機能",
  3: "データとアーキテクチャ",
  4: "プロンプトエンジニアリングとコンテキスト",
  5: "開発者の生産性",
  6: "プライバシー・コンテンツ除外・保護策",
};
const LS_PROGRESS = "gh300study.progress.v1";
const LS_SESSIONS = "gh300study.sessions.v1";
const LETTERS = ["A", "B", "C", "D"];

// ============================================================
// SRS（SM-2）— Swift版 SRSScheduler と同一ルール
// ============================================================
const SRS = {
  MIN_EASE: 1.3,
  INITIAL_EASE: 2.5,
  GRADE_Q: { again: 2, hard: 3, good: 4, easy: 5 },

  startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  },

  addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  },

  // state: {easeFactor, intervalDays, repetitions} / grade: "again"|"hard"|"good"|"easy"
  // 戻り値: {state, dueDate}
  schedule(state, grade, from = new Date()) {
    const q = SRS.GRADE_Q[grade];
    const next = { ...state };

    // EFの更新: EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))、下限1.3
    const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    next.easeFactor = Math.max(SRS.MIN_EASE, state.easeFactor + delta);

    if (q < 3) {
      // 思い出せなかった: 間隔をリセットし、当日中に再出題
      next.repetitions = 0;
      next.intervalDays = 0;
      return { state: next, dueDate: SRS.startOfDay(from) };
    }

    next.repetitions = state.repetitions + 1;
    if (next.repetitions === 1) {
      next.intervalDays = 1;
    } else if (next.repetitions === 2) {
      next.intervalDays = 6;
    } else {
      next.intervalDays = Math.max(1, Math.round(state.intervalDays * next.easeFactor));
    }
    return { state: next, dueDate: SRS.addDays(SRS.startOfDay(from), next.intervalDays) };
  },

  isDue(dueDate, now = new Date()) {
    return SRS.startOfDay(new Date(dueDate)) <= SRS.startOfDay(now);
  },
};

// ============================================================
// 状態管理（localStorage）
// ============================================================
const Store = {
  progress: {}, // questionID -> progress object
  sessions: [],

  load() {
    try {
      this.progress = JSON.parse(localStorage.getItem(LS_PROGRESS)) || {};
    } catch { this.progress = {}; }
    try {
      this.sessions = JSON.parse(localStorage.getItem(LS_SESSIONS)) || [];
    } catch { this.sessions = []; }
  },

  save() {
    localStorage.setItem(LS_PROGRESS, JSON.stringify(this.progress));
    localStorage.setItem(LS_SESSIONS, JSON.stringify(this.sessions));
  },

  // 問題バンクにあって進捗がない問題に初期レコードを作る（iOS版 seedIfNeeded 相当）
  seed(bank) {
    let changed = false;
    for (const q of bank) {
      if (!this.progress[q.id]) {
        this.progress[q.id] = {
          questionID: q.id,
          domain: q.domain,
          easeFactor: SRS.INITIAL_EASE,
          intervalDays: 0,
          repetitions: 0,
          dueDate: SRS.startOfDay(new Date()).toISOString(),
          correctCount: 0,
          wrongCount: 0,
          lastReviewedAt: null,
        };
        changed = true;
      }
    }
    if (changed) this.save();
  },
};

function attemptsOf(p) { return p.correctCount + p.wrongCount; }

function durationString(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

// ============================================================
// 画面遷移
// ============================================================
const screens = ["home", "practice", "done", "stats"];
function showScreen(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
  document.getElementById("tab-home").classList.toggle("active", name === "home");
  document.getElementById("tab-stats").classList.toggle("active", name === "stats");
  window.scrollTo(0, 0);
}

// ============================================================
// ホーム画面
// ============================================================
let bank = [];

function dueReviews() {
  return Object.values(Store.progress)
    .filter((p) => attemptsOf(p) > 0 && SRS.isDue(p.dueDate))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
}

function renderHome() {
  const due = dueReviews();
  document.getElementById("due-count").textContent = due.length;
  document.getElementById("no-due").hidden = due.length > 0;
  document.getElementById("btn-start-review").hidden = due.length === 0;

  const list = document.getElementById("domain-list");
  list.innerHTML = "";
  for (let d = 1; d <= 6; d++) {
    const count = bank.filter((q) => q.domain === d).length;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.innerHTML = `<span></span><span class="value">${count}問</span>`;
    row.firstElementChild.textContent = DOMAIN_NAMES[d];
    row.addEventListener("click", () => startPractice("practice", d));
    list.appendChild(row);
  }

  const totalSeconds = Store.sessions.reduce((s, x) => s + x.durationSeconds, 0);
  document.getElementById("home-total-time").textContent = durationString(totalSeconds);
  document.getElementById("home-session-count").textContent = `${Store.sessions.length} 回`;
}

// ============================================================
// 演習
// ============================================================
const Practice = {
  queue: [],
  index: 0,
  selected: null,
  revealed: false,
  sessionCorrect: 0,
  answered: 0,
  mode: "practice", // "practice" | "review"
  startedAt: null,

  start(mode, queue) {
    this.mode = mode;
    this.queue = queue;
    this.index = 0;
    this.sessionCorrect = 0;
    this.answered = 0;
    this.startedAt = new Date();
    showScreen("practice");
    document.getElementById("practice-title").textContent =
      mode === "review" ? "今日の復習" : DOMAIN_NAMES[queue[0].domain];
    this.renderQuestion();
  },

  current() { return this.queue[this.index]; },

  renderQuestion() {
    const q = this.current();
    this.selected = null;
    this.revealed = false;
    document.getElementById("practice-progress").textContent =
      `問題 ${this.index + 1} / ${this.queue.length}`;
    document.getElementById("q-domain").textContent = DOMAIN_NAMES[q.domain];
    document.getElementById("q-text").textContent = q.question;
    document.getElementById("q-feedback").hidden = true;

    const box = document.getElementById("q-choices");
    box.innerHTML = "";
    q.choices.forEach((choice, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.innerHTML = `<span class="letter">${LETTERS[i]}.</span><span></span>`;
      btn.lastElementChild.textContent = choice;
      btn.addEventListener("click", () => this.answer(i));
      box.appendChild(btn);
    });
  },

  answer(i) {
    if (this.revealed) return;
    this.revealed = true;
    this.selected = i;
    const q = this.current();
    const correct = i === q.correctIndex;
    this.answered += 1;
    if (correct) this.sessionCorrect += 1;

    // 正誤を記録
    const p = Store.progress[q.id];
    if (correct) p.correctCount += 1; else p.wrongCount += 1;
    Store.save();

    // 選択肢の見た目を更新
    const buttons = document.querySelectorAll("#q-choices .choice");
    buttons.forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === q.correctIndex) btn.classList.add("correct");
      else if (idx === i) btn.classList.add("wrong");
    });

    const result = document.getElementById("q-result");
    result.textContent = correct
      ? "正解です"
      : `不正解です。正解は ${LETTERS[q.correctIndex]} です。`;
    result.className = `q-result ${correct ? "ok" : "ng"}`;
    document.getElementById("q-explanation").textContent = q.explanation;
    document.getElementById("q-feedback").hidden = false;
  },

  grade(gradeName) {
    const q = this.current();
    const p = Store.progress[q.id];
    // 不正解の場合は高評価を選んでも "again" として扱う（iOS版と同一挙動）
    const effective = this.selected === q.correctIndex ? gradeName : "again";
    const { state, dueDate } = SRS.schedule(
      { easeFactor: p.easeFactor, intervalDays: p.intervalDays, repetitions: p.repetitions },
      effective
    );
    p.easeFactor = state.easeFactor;
    p.intervalDays = state.intervalDays;
    p.repetitions = state.repetitions;
    p.dueDate = dueDate.toISOString();
    p.lastReviewedAt = new Date().toISOString();
    Store.save();

    if (this.index + 1 < this.queue.length) {
      this.index += 1;
      this.renderQuestion();
    } else {
      this.finish();
    }
  },

  // セッションを保存する。回答0件・30秒未満は記録しない（iOS版 SessionTimer と同一条件）
  saveSession() {
    if (!this.startedAt) return;
    const endedAt = new Date();
    const seconds = Math.floor((endedAt - this.startedAt) / 1000);
    if (this.answered > 0 && seconds >= 30) {
      Store.sessions.push({
        startedAt: this.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSeconds: seconds,
        mode: this.mode,
        questionsAnswered: this.answered,
      });
      Store.save();
    }
    this.startedAt = null;
  },

  finish() {
    this.saveSession();
    document.getElementById("done-summary").textContent =
      `${this.queue.length} 問中 ${this.sessionCorrect} 問正解`;
    showScreen("done");
  },

  quit() {
    this.saveSession();
    renderHome();
    showScreen("home");
  },
};

function startPractice(mode, domain) {
  let queue;
  if (mode === "review") {
    const ids = dueReviews().map((p) => p.questionID);
    queue = ids.map((id) => bank.find((q) => q.id === id)).filter(Boolean);
  } else {
    queue = bank
      .filter((q) => q.domain === domain)
      .sort((a, b) => new Date(Store.progress[a.id].dueDate) - new Date(Store.progress[b.id].dueDate));
  }
  if (queue.length === 0) return;
  Practice.start(mode, queue);
}

// ============================================================
// 記録画面
// ============================================================
function renderStats() {
  const all = Object.values(Store.progress);
  const totalSeconds = Store.sessions.reduce((s, x) => s + x.durationSeconds, 0);
  const answered = all.reduce((s, p) => s + attemptsOf(p), 0);
  const correct = all.reduce((s, p) => s + p.correctCount, 0);

  document.getElementById("st-total-time").textContent = durationString(totalSeconds);
  document.getElementById("st-session-count").textContent = `${Store.sessions.length} 回`;
  document.getElementById("st-answered").textContent = `${answered} 問`;
  document.getElementById("st-accuracy").textContent =
    answered === 0 ? "—" : `${Math.round((correct / answered) * 100)}%`;
  document.getElementById("st-due").textContent = `${dueReviews().length} 問`;

  const dbox = document.getElementById("st-domains");
  dbox.innerHTML = "";
  for (let d = 1; d <= 6; d++) {
    const items = all.filter((p) => p.domain === d);
    const att = items.reduce((s, p) => s + attemptsOf(p), 0);
    const cor = items.reduce((s, p) => s + p.correctCount, 0);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span></span><span class="value"></span>`;
    row.firstElementChild.textContent = DOMAIN_NAMES[d];
    row.lastElementChild.textContent =
      att === 0 ? "未着手" : `${cor}/${att}（${Math.round((cor / att) * 100)}%）`;
    dbox.appendChild(row);
  }

  const sbox = document.getElementById("st-sessions");
  sbox.innerHTML = "";
  if (Store.sessions.length === 0) {
    sbox.innerHTML = `<div class="row"><span class="muted">まだ記録がありません。演習をはじめると自動で記録されます。</span></div>`;
  } else {
    const fmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    [...Store.sessions]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 10)
      .forEach((s) => {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span></span><span class="value"></span>`;
        row.firstElementChild.textContent = fmt.format(new Date(s.startedAt));
        row.lastElementChild.textContent =
          `${s.mode === "review" ? "復習" : "演習"} ・ ${durationString(s.durationSeconds)}`;
        sbox.appendChild(row);
      });
  }
}

// ============================================================
// 書き出し / 読み込み（iOS版 ExportPayload と同一スキーマ）
// ============================================================
function buildExportPayload() {
  const all = Object.values(Store.progress);
  const perDomain = {};
  for (let d = 1; d <= 6; d++) {
    const items = all.filter((p) => p.domain === d);
    const att = items.reduce((s, p) => s + attemptsOf(p), 0);
    const cor = items.reduce((s, p) => s + p.correctCount, 0);
    perDomain[DOMAIN_NAMES[d]] = att === 0 ? 0 : cor / att;
  }
  return {
    exportedAt: new Date().toISOString(),
    app: "GH300Study",
    sessions: [...Store.sessions].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)),
    progress: all
      .sort((a, b) => a.questionID.localeCompare(b.questionID))
      .map((p) => ({
        questionID: p.questionID,
        domain: p.domain,
        domainName: DOMAIN_NAMES[p.domain],
        correctCount: p.correctCount,
        wrongCount: p.wrongCount,
        easeFactor: p.easeFactor,
        intervalDays: p.intervalDays,
        repetitions: p.repetitions,
        dueDate: p.dueDate,
        lastReviewedAt: p.lastReviewedAt,
      })),
    summary: {
      totalStudySeconds: Store.sessions.reduce((s, x) => s + x.durationSeconds, 0),
      sessionCount: Store.sessions.length,
      totalAnswered: all.reduce((s, p) => s + attemptsOf(p), 0),
      totalCorrect: all.reduce((s, p) => s + p.correctCount, 0),
      dueReviewCount: dueReviews().length,
      perDomainAccuracy: perDomain,
    },
  };
}

async function exportJSON() {
  const payload = buildExportPayload();
  const text = JSON.stringify(payload, null, 2);
  const file = new File([text], "gh300-study-export.json", { type: "application/json" });
  // iPhone等では共有シートを優先し、使えない環境ではダウンロードする
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch { /* キャンセル時はダウンロードにフォールバック */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = "gh300-study-export.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function importJSON(file) {
  const message = document.getElementById("import-message");
  file.text().then((text) => {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      message.textContent = "読み込みに失敗しました：JSONとして解釈できませんでした。";
      return;
    }
    if (!payload || !Array.isArray(payload.progress) || !Array.isArray(payload.sessions)) {
      message.textContent = "読み込みに失敗しました：学習ログの形式ではないようです。";
      return;
    }
    if (!window.confirm("現在の進捗と学習記録を、読み込むファイルの内容で置き換えます。よろしいですか？")) {
      return;
    }
    Store.progress = {};
    for (const p of payload.progress) {
      Store.progress[p.questionID] = {
        questionID: p.questionID,
        domain: p.domain,
        easeFactor: p.easeFactor ?? SRS.INITIAL_EASE,
        intervalDays: p.intervalDays ?? 0,
        repetitions: p.repetitions ?? 0,
        dueDate: p.dueDate,
        correctCount: p.correctCount ?? 0,
        wrongCount: p.wrongCount ?? 0,
        lastReviewedAt: p.lastReviewedAt ?? null,
      };
    }
    Store.sessions = payload.sessions;
    Store.seed(bank); // 新しく増えた問題があれば初期レコードを補う
    Store.save();
    message.textContent = `読み込みました（${payload.progress.length}問分の進捗、セッション${payload.sessions.length}件）。`;
    renderStats();
    renderHome();
  });
}

// ============================================================
// 初期化
// ============================================================
async function init() {
  Store.load();
  try {
    const res = await fetch("questions.json");
    const data = await res.json();
    bank = data.questions || [];
  } catch {
    document.getElementById("due-count").textContent = "—";
    document.getElementById("no-due").hidden = false;
    document.getElementById("no-due").textContent =
      "問題データ（questions.json）の読み込みに失敗しました。HTTPサーバー経由で開いているか確認してください。";
    document.getElementById("btn-start-review").hidden = true;
    return;
  }
  Store.seed(bank);
  renderHome();
  showScreen("home");
}

document.getElementById("btn-start-review").addEventListener("click", () => startPractice("review"));
document.getElementById("btn-quit-practice").addEventListener("click", () => Practice.quit());
document.getElementById("btn-done-home").addEventListener("click", () => { renderHome(); showScreen("home"); });
document.querySelectorAll(".btn.grade").forEach((btn) => {
  btn.addEventListener("click", () => Practice.grade(btn.dataset.grade));
});
document.getElementById("tab-home").addEventListener("click", () => { renderHome(); showScreen("home"); });
document.getElementById("tab-stats").addEventListener("click", () => { renderStats(); showScreen("stats"); });
document.getElementById("btn-export").addEventListener("click", exportJSON);
document.getElementById("file-import").addEventListener("change", (e) => {
  if (e.target.files[0]) importJSON(e.target.files[0]);
  e.target.value = "";
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => { /* file:// 等では登録できないが動作に支障なし */ });
  });
}

init();
