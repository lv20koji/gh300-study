"use strict";
/* 資格勉強ポータル（Web版 v3）
   - 複数科目パック対応（questions.json の subjects 配列）
   - 進捗・セッションは科目ごとに localStorage へ分離保存
     キー: studyapp.progress.v2.<科目ID> / studyapp.sessions.v2.<科目ID>
   - GH-300 の v1 キー（gh300study.*.v1）があれば初回に v2 へ引き継ぐ（v1は消さない）
   - SRS: SM-2方式（v1と同一ルール）
   - 書き出し/読み込み: 全科目を含む v2 スキーマ（v1形式の読み込みにも対応）
   - v3追加: 学習ストリーク＋カレンダー、復習フォーキャスト、間違いノート、試験日カウントダウン
     （いずれも既存の端末内データからの表示のみ。試験日は studyapp.examdate.v3.<科目ID> に保存） */

// ============================================================
// 定数
// ============================================================
const LS2_PROGRESS = (id) => `studyapp.progress.v2.${id}`;
const LS2_SESSIONS = (id) => `studyapp.sessions.v2.${id}`;
const LS_CURRENT = "studyapp.currentSubject.v2";
const LS1_PROGRESS = "gh300study.progress.v1";
const LS1_SESSIONS = "gh300study.sessions.v1";
const LETTERS = ["A", "B", "C", "D"];
const MODE_LABELS = {
  review: "復習", practice: "演習", new: "新規問題",
  weak: "弱点集中", test: "ミニテスト", flashcard: "フラッシュカード",
  note: "間違いノート",
};
const TEST_SIZE = 10;
const WEAK_SIZE = 20;
const FLASH_SIZE = 20;
const NOTE_SIZE = 30;

// ============================================================
// SRS（SM-2）— v1と同一ルール
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

  schedule(state, grade, from = new Date()) {
    const q = SRS.GRADE_Q[grade];
    const next = { ...state };
    const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    next.easeFactor = Math.max(SRS.MIN_EASE, state.easeFactor + delta);

    if (q < 3) {
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
// 科目パックと状態管理
// ============================================================
let packs = []; // questions.json の subjects
let cur = null; // 現在開いている科目パック

function packById(id) { return packs.find((p) => p.id === id) || null; }
function domainName(pack, d) { return pack.domains[String(d)] || `分野${d}`; }

const Store = {
  data: {}, // subjectId -> {progress: {}, sessions: []}

  loadSubject(pack) {
    if (this.data[pack.id]) return;
    let rawP = localStorage.getItem(LS2_PROGRESS(pack.id));
    let rawS = localStorage.getItem(LS2_SESSIONS(pack.id));
    // GH-300 の v1 データがあれば引き継ぐ（v1キーは残す）
    if (pack.id === "gh300") {
      if (rawP == null) rawP = localStorage.getItem(LS1_PROGRESS);
      if (rawS == null) rawS = localStorage.getItem(LS1_SESSIONS);
    }
    let progress = {}, sessions = [];
    try { progress = JSON.parse(rawP) || {}; } catch { progress = {}; }
    try { sessions = JSON.parse(rawS) || []; } catch { sessions = []; }
    this.data[pack.id] = { progress, sessions };
    this.seed(pack);
    this.saveSubject(pack.id);
  },

  saveSubject(id) {
    const d = this.data[id];
    if (!d) return;
    localStorage.setItem(LS2_PROGRESS(id), JSON.stringify(d.progress));
    localStorage.setItem(LS2_SESSIONS(id), JSON.stringify(d.sessions));
  },

  save() { if (cur) this.saveSubject(cur.id); },

  seed(pack) {
    const d = this.data[pack.id];
    for (const q of pack.questions) {
      if (!d.progress[q.id]) {
        d.progress[q.id] = {
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
      }
    }
  },
};

function attemptsOf(p) { return p.correctCount + p.wrongCount; }

function durationString(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// 科目ごとの集計
// ============================================================
function dueReviews(pack) {
  const d = Store.data[pack.id];
  return Object.values(d.progress)
    .filter((p) => attemptsOf(p) > 0 && SRS.isDue(p.dueDate))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
}

function unattempted(pack) {
  const d = Store.data[pack.id];
  return pack.questions.filter((q) => attemptsOf(d.progress[q.id]) === 0);
}

function weakQuestions(pack) {
  const d = Store.data[pack.id];
  return pack.questions
    .map((q) => ({ q, p: d.progress[q.id] }))
    .filter(({ p }) => attemptsOf(p) > 0 && (p.easeFactor < SRS.INITIAL_EASE || p.wrongCount > 0))
    .sort((a, b) => {
      if (a.p.easeFactor !== b.p.easeFactor) return a.p.easeFactor - b.p.easeFactor;
      const ra = a.p.wrongCount / attemptsOf(a.p), rb = b.p.wrongCount / attemptsOf(b.p);
      return rb - ra;
    })
    .map(({ q }) => q)
    .slice(0, WEAK_SIZE);
}

function flashQuestions(pack) {
  const d = Store.data[pack.id];
  const due = dueReviews(pack).map((p) => pack.questions.find((q) => q.id === p.questionID)).filter(Boolean);
  const rest = pack.questions
    .filter((q) => !due.includes(q))
    .sort((a, b) => new Date(d.progress[a.id].dueDate) - new Date(d.progress[b.id].dueDate));
  return [...due, ...rest].slice(0, FLASH_SIZE);
}

function subjectTotals(pack) {
  const d = Store.data[pack.id];
  const all = Object.values(d.progress);
  const answered = all.reduce((s, p) => s + attemptsOf(p), 0);
  const correct = all.reduce((s, p) => s + p.correctCount, 0);
  return {
    seconds: d.sessions.reduce((s, x) => s + x.durationSeconds, 0),
    sessionCount: d.sessions.length,
    answered,
    correct,
    accuracy: answered === 0 ? null : correct / answered,
    due: dueReviews(pack).length,
  };
}

// ============================================================
// v3: 学習ストリーク / カレンダー / 復習フォーキャスト（既存ログからの集計のみ）
// ============================================================
function dayKeyOf(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 全科目のセッション記録から、学習した日の集合を作る
function studyDaySet() {
  const days = new Set();
  for (const pack of packs) {
    for (const s of Store.data[pack.id].sessions) days.add(dayKeyOf(s.startedAt));
  }
  return days;
}

function streakInfo() {
  const days = studyDaySet();
  if (days.size === 0) return { current: 0, longest: 0, total: 0 };
  const sorted = [...days].sort();
  // 最長連続
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = SRS.addDays(new Date(sorted[i - 1] + "T00:00:00"), 1);
    if (dayKeyOf(prev) === sorted[i]) { run += 1; longest = Math.max(longest, run); }
    else run = 1;
  }
  // 現在の連続（今日、まだなら昨日から途切れていないか）
  let current = 0;
  let cursor = SRS.startOfDay(new Date());
  if (!days.has(dayKeyOf(cursor))) cursor = SRS.addDays(cursor, -1);
  while (days.has(dayKeyOf(cursor))) {
    current += 1;
    cursor = SRS.addDays(cursor, -1);
  }
  return { current, longest, total: days.size };
}

// これから先の復習予定（着手済みの問題のみ、全科目合算）
function forecastCounts() {
  const today = SRS.startOfDay(new Date());
  let tomorrow = 0, week = 0;
  for (const pack of packs) {
    for (const p of Object.values(Store.data[pack.id].progress)) {
      if (attemptsOf(p) === 0) continue;
      const due = SRS.startOfDay(new Date(p.dueDate));
      const diff = Math.round((due - today) / 86400000);
      if (diff === 1) tomorrow += 1;
      else if (diff >= 2 && diff <= 7) week += 1;
    }
  }
  return { tomorrow, week };
}

// ============================================================
// v3: 試験日カウントダウン（端末内のみ保存）
// ============================================================
const LS_EXAMDATE = (id) => `studyapp.examdate.v3.${id}`;

function examDateOf(pack) {
  const raw = localStorage.getItem(LS_EXAMDATE(pack.id));
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function daysUntilExam(pack) {
  const raw = examDateOf(pack);
  if (!raw) return null;
  const target = SRS.startOfDay(new Date(raw + "T00:00:00"));
  const diff = Math.round((target - SRS.startOfDay(new Date())) / 86400000);
  return diff;
}

// ============================================================
// v3: 間違いノート（1回以上間違えた問題）
// ============================================================
function wrongQuestions(pack) {
  const d = Store.data[pack.id];
  return pack.questions
    .map((q) => ({ q, p: d.progress[q.id] }))
    .filter(({ p }) => p.wrongCount > 0)
    .sort((a, b) => {
      if (a.p.wrongCount !== b.p.wrongCount) return b.p.wrongCount - a.p.wrongCount;
      return new Date(a.p.dueDate) - new Date(b.p.dueDate);
    });
}

// ============================================================
// 画面遷移
// ============================================================
const screens = ["portal", "subject", "practice", "done", "stats", "note"];
function showScreen(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
  document.getElementById("tab-home").classList.toggle("active", name === "portal" || name === "subject" || name === "note");
  document.getElementById("tab-stats").classList.toggle("active", name === "stats");
  window.scrollTo(0, 0);
}

// ============================================================
// ポータル画面
// ============================================================
function renderPortal() {
  // 「今日はこちらから」：復習が最も多い科目 → なければ未学習のある科目
  const startBtn = document.getElementById("btn-portal-start");
  const text = document.getElementById("portal-today-text");
  let target = null, kind = null;
  for (const pack of packs) {
    const due = dueReviews(pack).length;
    if (due > 0 && (!target || due > target.count)) target = { pack, count: due }, kind = "review";
  }
  if (!target) {
    for (const pack of packs) {
      const n = unattempted(pack).length;
      if (n > 0) { target = { pack, count: n }; kind = "new"; break; }
    }
  }
  if (target && kind === "review") {
    text.textContent = `${target.pack.name} の復習が ${target.count} 問たまっています。`;
    startBtn.textContent = `▶ ${target.pack.shortName} の復習をはじめる（${target.count}問）`;
    startBtn.hidden = false;
    startBtn.onclick = () => { openSubject(target.pack.id); startPractice("review"); };
  } else if (target && kind === "new") {
    text.textContent = `今日の復習はありません。${target.pack.name} の新しい問題が ${target.count} 問あります。`;
    startBtn.textContent = `▶ ${target.pack.shortName} の新しい問題をはじめる`;
    startBtn.hidden = false;
    startBtn.onclick = () => { openSubject(target.pack.id); startNew(); };
  } else {
    text.textContent = "今日の分は完了です。お疲れさまでした。下の科目から自由に学習できます。";
    startBtn.hidden = true;
    startBtn.onclick = null;
  }

  // 科目カード
  const box = document.getElementById("subject-cards");
  box.innerHTML = "";
  for (const pack of packs) {
    const t = subjectTotals(pack);
    const card = document.createElement("div");
    card.className = "card subject-card";
    card.innerHTML = `
      <h3></h3>
      <div class="subject-stats">
        <span>復習待ち <strong>${t.due}問</strong></span>
        <span>正答率 <strong>${t.accuracy === null ? "—" : Math.round(t.accuracy * 100) + "%"}</strong></span>
        <span>累計 <strong>${durationString(t.seconds)}</strong></span>
      </div>
      <button class="btn primary" type="button">この科目を勉強する ›</button>`;
    card.querySelector("h3").textContent = pack.name;
    const days = daysUntilExam(pack);
    if (days !== null) {
      const line = document.createElement("p");
      line.className = "exam-line";
      const raw = examDateOf(pack);
      const [, m, dd] = raw.split("-");
      line.textContent = days > 0
        ? `🎯 試験まであと ${days} 日（${Number(m)}月${Number(dd)}日）`
        : days === 0
          ? `🎯 今日が試験日です（${Number(m)}月${Number(dd)}日）。がんばってください！`
          : `🎯 試験日（${Number(m)}月${Number(dd)}日）は過ぎました。お疲れさまでした`;
      card.insertBefore(line, card.querySelector("button"));
    }
    card.querySelector("button").addEventListener("click", () => openSubject(pack.id));
    box.appendChild(card);
  }

  renderPortalActivity();
}

// ポータルの「学習の記録」：ストリーク、直近4週間のカレンダー、復習フォーキャスト
function renderPortalActivity() {
  const streakEl = document.getElementById("portal-streak");
  const calEl = document.getElementById("portal-calendar");
  const fcEl = document.getElementById("portal-forecast");
  const info = streakInfo();
  const days = studyDaySet();
  const todayKey = dayKeyOf(new Date());

  if (info.total === 0) {
    streakEl.textContent = "まだ学習記録がありません。最初の1問からはじめましょう。";
  } else {
    streakEl.innerHTML =
      `🔥 <strong>${info.current} 日</strong> 連続学習中` +
      `<span class="muted small">（最長 ${info.longest} 日 ／ 学習した日は合計 ${info.total} 日）</span>`;
    if (!days.has(todayKey)) {
      streakEl.innerHTML += `<br><span class="small">今日まだ学習していません。1問だけでも解くと記録が続きます。</span>`;
    }
  }

  calEl.innerHTML = "";
  for (let i = 27; i >= 0; i--) {
    const d = SRS.addDays(SRS.startOfDay(new Date()), -i);
    const key = dayKeyOf(d);
    const cell = document.createElement("div");
    cell.className = "cal-day" + (days.has(key) ? " on" : "") + (key === todayKey ? " today" : "");
    cell.title = `${d.getMonth() + 1}月${d.getDate()}日` + (days.has(key) ? "：学習あり" : "");
    calEl.appendChild(cell);
  }

  const fc = forecastCounts();
  const dueTotal = packs.reduce((s, pack) => s + dueReviews(pack).length, 0);
  fcEl.textContent =
    `復習の見通し（全科目）：今日 ${dueTotal} 問 ・ 明日 ${fc.tomorrow} 問 ・ あさって〜1週間 ${fc.week} 問`;
}

// ============================================================
// 科目画面
// ============================================================
function openSubject(id) {
  cur = packById(id) || packs[0];
  localStorage.setItem(LS_CURRENT, cur.id);
  renderSubject();
  showScreen("subject");
}

function renderSubject() {
  document.getElementById("subject-title").textContent = cur.name;

  const due = dueReviews(cur);
  document.getElementById("due-count").textContent = due.length;
  document.getElementById("no-due").hidden = due.length > 0;
  document.getElementById("btn-start-review").hidden = due.length === 0;

  // 学習モード一覧
  const modes = document.getElementById("mode-list");
  modes.innerHTML = "";
  const addModeRow = (label, value, handler, disabled) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row" + (disabled ? " disabled" : "");
    row.innerHTML = `<span></span><span class="value">${value}</span>`;
    row.firstElementChild.textContent = label;
    if (!disabled) row.addEventListener("click", handler);
    modes.appendChild(row);
  };
  const fresh = unattempted(cur);
  if (fresh.length > 0) {
    addModeRow("新しい問題に挑戦", `未学習 ${fresh.length}問`, () => startNew(), false);
  }
  addModeRow("ランダムミニテスト（診断）", `${Math.min(TEST_SIZE, cur.questions.length)}問`, () => startTest(), false);
  const weak = weakQuestions(cur);
  addModeRow("弱点集中", weak.length === 0 ? "対象なし" : `${weak.length}問`, () => startWeak(), weak.length === 0);
  const wrong = wrongQuestions(cur);
  addModeRow("間違いノート", wrong.length === 0 ? "対象なし" : `${wrong.length}問`, () => { renderNote(); showScreen("note"); }, wrong.length === 0);
  addModeRow("フラッシュカード", `${flashQuestions(cur).length}問`, () => startFlashcard(), false);

  // 分野別演習
  const list = document.getElementById("domain-list");
  list.innerHTML = "";
  for (const d of Object.keys(cur.domains)) {
    const count = cur.questions.filter((q) => q.domain === Number(d)).length;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.innerHTML = `<span></span><span class="value">${count}問</span>`;
    row.firstElementChild.textContent = cur.domains[d];
    row.addEventListener("click", () => startPractice("practice", Number(d)));
    list.appendChild(row);
  }

  const t = subjectTotals(cur);
  document.getElementById("subj-total-time").textContent = durationString(t.seconds);
  document.getElementById("subj-session-count").textContent = `${t.sessionCount} 回`;
  document.getElementById("subj-accuracy").textContent =
    t.accuracy === null ? "—" : `${Math.round(t.accuracy * 100)}%`;

  renderExamCard();
  renderRoadmap();
}

// 科目画面の「試験日に向けて」カード
function renderExamCard() {
  const countEl = document.getElementById("exam-countdown");
  const subEl = document.getElementById("exam-countdown-sub");
  const input = document.getElementById("exam-date-input");
  const days = daysUntilExam(cur);
  input.value = examDateOf(cur) || "";
  if (days === null) {
    countEl.hidden = true;
    subEl.textContent = "試験日を設定すると、ここに残り日数が表示されます（この端末にだけ保存されます）。";
    return;
  }
  const raw = examDateOf(cur);
  const [y, m, dd] = raw.split("-").map(Number);
  const dateLabel = `${y}年${m}月${dd}日`;
  countEl.hidden = false;
  if (days > 0) {
    countEl.innerHTML = `あと ${days} <small>日</small>`;
    subEl.textContent = `試験日は ${dateLabel} です。ロードマップの現在地を毎日少しずつ進めましょう。`;
  } else if (days === 0) {
    countEl.innerHTML = `今日 <small>が試験日</small>`;
    subEl.textContent = `試験日は ${dateLabel} です。これまでの積み重ねを信じて臨みましょう。`;
  } else {
    countEl.innerHTML = `終了 <small>しました</small>`;
    subEl.textContent = `試験日（${dateLabel}）は過ぎました。次の目標に向けて試験日を更新できます。`;
  }
}

// ============================================================
// 合格への最短ルート（ロードマップ）
// 進捗は既存の学習記録と、公式リンクを開いた記録（この端末内のみ）から判定する
// ============================================================
const LS_ROADMAP = (id) => `studyapp.roadmap.v2.${id}`;
const ROADMAPS = {
  gh300: [
    { key: "input", title: "概念インプット", desc: "公式の学習ガイドとラーニングパスで全体像をつかむ", kind: "link", url: "https://learn.microsoft.com/ja-jp/credentials/certifications/resources/study-guides/gh-300", actionLabel: "公式ガイドを開く" },
    { key: "drill", title: "分野別ドリル", desc: "分野ごとに演習して基礎を固める（全分野に着手が目標）", kind: "domains", actionLabel: "ドリルをはじめる" },
    { key: "diag", title: "ミニテストで診断", desc: "ランダム10問で弱点を洗い出す", kind: "test", actionLabel: "ミニテストを受ける" },
    { key: "weak", title: "弱点集中", desc: "苦手な問題だけを集中的に克服する", kind: "weak", actionLabel: "弱点を攻める" },
    { key: "assess", title: "公式の模擬評価", desc: "公式の無料プラクティス評価で本番形式に慣れる", kind: "link", url: "https://learn.microsoft.com/ja-jp/credentials/certifications/github-copilot/", actionLabel: "公式ページを開く" },
    { key: "finish", title: "仕上げ", desc: "全問題に着手し、復習キューをゼロにして定着させる", kind: "review", actionLabel: "復習する" },
  ],
  ap: [
    { key: "input", title: "概念インプット", desc: "IPA公式シラバスで出題範囲と学習目標を確認する", kind: "link", url: "https://www.ipa.go.jp/shiken/syllabus/gaiyou.html", actionLabel: "公式シラバスを開く" },
    { key: "drill", title: "分野別ドリル", desc: "分野ごとに演習して基礎を固める（全分野に着手が目標）", kind: "domains", actionLabel: "ドリルをはじめる" },
    { key: "diag", title: "ミニテストで診断", desc: "ランダム10問で弱点を洗い出す", kind: "test", actionLabel: "ミニテストを受ける" },
    { key: "weak", title: "弱点集中", desc: "苦手な問題だけを集中的に克服する", kind: "weak", actionLabel: "弱点を攻める" },
    { key: "assess", title: "公式情報で最終確認", desc: "IPA公式ページで試験区分の概要・出題形式を確認する", kind: "link", url: "https://www.ipa.go.jp/shiken/kubun/ap.html", actionLabel: "公式ページを開く" },
    { key: "finish", title: "仕上げ", desc: "全問題に着手し、復習キューをゼロにして定着させる", kind: "review", actionLabel: "復習する" },
  ],
};

function roadmapFlags(pack) {
  try { return JSON.parse(localStorage.getItem(LS_ROADMAP(pack.id))) || {}; }
  catch { return {}; }
}

function stepDone(pack, step) {
  const d = Store.data[pack.id];
  switch (step.key) {
    case "input":
    case "assess":
      return !!roadmapFlags(pack)[step.key];
    case "drill":
      return Object.keys(pack.domains).every((dn) =>
        pack.questions.some((q) => q.domain === Number(dn) && attemptsOf(d.progress[q.id]) > 0));
    case "diag":
      return d.sessions.some((s) => s.mode === "test");
    case "weak":
      return d.sessions.some((s) => s.mode === "weak");
    case "finish":
      return pack.questions.every((q) => attemptsOf(d.progress[q.id]) > 0) && dueReviews(pack).length === 0;
    default:
      return false;
  }
}

function drillTargetDomain(pack) {
  const d = Store.data[pack.id];
  // 未着手の分野を優先し、なければ正答率が最も低い分野
  for (const dn of Object.keys(pack.domains)) {
    if (pack.questions.some((q) => q.domain === Number(dn) && attemptsOf(d.progress[q.id]) === 0)) {
      return Number(dn);
    }
  }
  let best = Number(Object.keys(pack.domains)[0]), bestAcc = Infinity;
  for (const dn of Object.keys(pack.domains)) {
    const items = Object.values(d.progress).filter((p) => p.domain === Number(dn) && attemptsOf(p) > 0);
    const att = items.reduce((s, p) => s + attemptsOf(p), 0);
    const cor = items.reduce((s, p) => s + p.correctCount, 0);
    const acc = att === 0 ? 0 : cor / att;
    if (acc < bestAcc) { bestAcc = acc; best = Number(dn); }
  }
  return best;
}

function runStep(pack, step) {
  if (cur.id !== pack.id) openSubject(pack.id);
  switch (step.kind) {
    case "link": {
      const flags = roadmapFlags(pack);
      flags[step.key] = true;
      localStorage.setItem(LS_ROADMAP(pack.id), JSON.stringify(flags));
      window.open(step.url, "_blank", "noopener");
      renderSubject();
      break;
    }
    case "domains": startPractice("practice", drillTargetDomain(pack)); break;
    case "test": startTest(); break;
    case "weak": startWeak(); break;
    case "review": startPractice("review"); break;
  }
}

function renderRoadmap() {
  const steps = ROADMAPS[cur.id];
  const box = document.getElementById("roadmap-steps");
  const startBtn = document.getElementById("btn-roadmap-start");
  const todayText = document.getElementById("roadmap-today-text");
  if (!steps) { box.innerHTML = ""; startBtn.hidden = true; todayText.textContent = ""; return; }

  const currentIdx = steps.findIndex((s) => !stepDone(cur, s));
  box.innerHTML = "";
  steps.forEach((step, i) => {
    const done = stepDone(cur, step);
    const row = document.createElement("div");
    row.className = "roadmap-step" + (done ? " done" : "") + (i === currentIdx ? " current" : "");
    const badge = document.createElement("span");
    badge.className = "step-badge";
    badge.textContent = done ? "✓" : String(i + 1);
    const body = document.createElement("div");
    body.className = "step-body";
    const title = document.createElement("div");
    title.className = "step-title";
    title.textContent = `Step ${i + 1}：${step.title}`;
    const desc = document.createElement("div");
    desc.className = "step-desc";
    desc.textContent = step.desc;
    body.appendChild(title);
    body.appendChild(desc);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn step-action";
    btn.textContent = step.actionLabel;
    btn.addEventListener("click", () => runStep(cur, step));
    row.appendChild(badge);
    row.appendChild(body);
    row.appendChild(btn);
    box.appendChild(row);
  });

  if (currentIdx === -1) {
    todayText.textContent = "全ステップ完了です。あとは復習を回して定着させましょう。";
    startBtn.hidden = true;
    startBtn.onclick = null;
  } else {
    const step = steps[currentIdx];
    todayText.textContent = `現在地は Step ${currentIdx + 1}「${step.title}」です。ここから進めるのが合格への近道です。`;
    startBtn.textContent = `▶ Step ${currentIdx + 1}：${step.title}をはじめる`;
    startBtn.hidden = false;
    startBtn.onclick = () => runStep(cur, step);
  }
}

// ============================================================
// 演習エンジン（通常・復習・新規・弱点・フラッシュカード・ミニテスト）
// ============================================================
const Practice = {
  queue: [],
  index: 0,
  selected: null,
  revealed: false,
  sessionCorrect: 0,
  answered: 0,
  mode: "practice",
  startedAt: null,
  answers: [], // ミニテスト用: 選んだ選択肢の記録
  timerId: null,

  start(mode, queue, title) {
    this.mode = mode;
    this.queue = queue;
    this.index = 0;
    this.sessionCorrect = 0;
    this.answered = 0;
    this.answers = [];
    this.startedAt = new Date();
    showScreen("practice");
    document.getElementById("practice-title").textContent = title;
    document.getElementById("done-detail").innerHTML = "";
    this.startTimerIfNeeded();
    this.renderQuestion();
  },

  startTimerIfNeeded() {
    this.stopTimer();
    const el = document.getElementById("practice-timer");
    if (this.mode !== "test") { el.hidden = true; return; }
    el.hidden = false;
    const tick = () => {
      const s = Math.floor((new Date() - this.startedAt) / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    this.timerId = setInterval(tick, 500);
  },

  stopTimer() {
    if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
  },

  current() { return this.queue[this.index]; },

  renderQuestion() {
    const q = this.current();
    const pack = cur;
    this.selected = null;
    this.revealed = false;
    document.getElementById("practice-progress").textContent =
      `問題 ${this.index + 1} / ${this.queue.length}`;
    document.getElementById("q-domain").textContent = domainName(pack, q.domain);
    document.getElementById("q-text").textContent = q.question;
    document.getElementById("q-feedback").hidden = true;
    document.getElementById("q-flash").hidden = this.mode !== "flashcard";
    const testNav = document.getElementById("q-test-nav");
    testNav.hidden = this.mode !== "test";
    if (this.mode === "test") {
      const nextBtn = document.getElementById("btn-test-next");
      nextBtn.disabled = true;
      nextBtn.textContent = this.index + 1 < this.queue.length ? "次へ" : "結果を見る";
    }

    const card = document.getElementById("practice-card");
    card.classList.remove("card-in");
    void card.offsetWidth; // アニメーションを再発火させる
    card.classList.add("card-in");

    const box = document.getElementById("q-choices");
    box.innerHTML = "";
    q.choices.forEach((choice, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.innerHTML = `<span class="letter">${LETTERS[i]}.</span><span></span>`;
      btn.lastElementChild.textContent = choice;
      if (this.mode === "flashcard") {
        btn.disabled = true; // フラッシュカードでは選択肢は表示のみ
      } else if (this.mode === "test") {
        btn.addEventListener("click", () => this.testSelect(i));
      } else {
        btn.addEventListener("click", () => this.answer(i));
      }
      box.appendChild(btn);
    });
  },

  // --- 通常モード（即時採点） ---
  answer(i) {
    if (this.revealed) return;
    this.revealed = true;
    this.selected = i;
    const q = this.current();
    const correct = i === q.correctIndex;
    this.answered += 1;
    if (correct) this.sessionCorrect += 1;

    const p = Store.data[cur.id].progress[q.id];
    if (correct) p.correctCount += 1; else p.wrongCount += 1;
    Store.save();

    const buttons = document.querySelectorAll("#q-choices .choice");
    buttons.forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === q.correctIndex) btn.classList.add("correct");
      else if (idx === i) btn.classList.add("wrong");
    });

    const result = document.getElementById("q-result");
    result.hidden = false;
    result.textContent = correct
      ? "正解です"
      : `不正解です。正解は ${LETTERS[q.correctIndex]} です。`;
    result.className = `q-result ${correct ? "ok" : "ng"}`;
    const note = document.getElementById("q-wrongnote");
    if (!correct && q.wrongNote) {
      note.textContent = `つまずきポイント：${q.wrongNote}`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    document.getElementById("q-explanation").textContent = q.explanation;
    document.getElementById("q-source").textContent = q.source || "";
    this.prepNextBtn();
    document.getElementById("q-feedback").hidden = false;
  },

  // --- フラッシュカード（答えの表示） ---
  revealFlash() {
    if (this.revealed) return;
    this.revealed = true;
    const q = this.current();
    const buttons = document.querySelectorAll("#q-choices .choice");
    buttons.forEach((btn, idx) => {
      if (idx === q.correctIndex) btn.classList.add("correct");
    });
    document.getElementById("q-result").hidden = true;
    document.getElementById("q-wrongnote").hidden = true;
    document.getElementById("q-explanation").textContent = q.explanation;
    document.getElementById("q-source").textContent = q.source || "";
    document.getElementById("q-flash").hidden = true;
    this.prepNextBtn();
    document.getElementById("q-feedback").hidden = false;
  },

  // フィードバック表示時に「次へ」ボタンのラベルを最終問題かどうかで切り替える
  prepNextBtn() {
    document.getElementById("btn-next-question").textContent =
      this.index + 1 < this.queue.length ? "次へ" : "結果を見る";
  },

  // --- 「次へ」: 自己評価は任意。付けずに進む場合は標準評価で記録する ---
  nextDefault() {
    if (this.mode === "flashcard") {
      // フラッシュカードは自己申告が本体なので、未評価では数えずに進むだけ
      if (this.index + 1 < this.queue.length) {
        this.index += 1;
        this.renderQuestion();
      } else {
        this.finish();
      }
      return;
    }
    // grade() 側で不正解は自動的に "again" になるため、正解・不正解とも "good" でよい
    this.grade("good");
  },

  // --- 自己評価（通常・弱点・復習・新規・フラッシュカード共通） ---
  grade(gradeName) {
    const q = this.current();
    const p = Store.data[cur.id].progress[q.id];
    let effective = gradeName;
    if (this.mode === "flashcard") {
      // 自己申告で数える：「もう一度」=思い出せなかった扱い
      this.answered += 1;
      if (gradeName === "again") p.wrongCount += 1;
      else { p.correctCount += 1; this.sessionCorrect += 1; }
    } else {
      // 不正解の場合は高評価を選んでも "again" として扱う（v1と同一挙動）
      effective = this.selected === q.correctIndex ? gradeName : "again";
    }
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

  // --- ミニテスト（最後まで答えを隠す） ---
  testSelect(i) {
    this.selected = i;
    document.querySelectorAll("#q-choices .choice").forEach((btn, idx) => {
      btn.classList.toggle("selected", idx === i);
    });
    document.getElementById("btn-test-next").disabled = false;
  },

  testNext() {
    if (this.selected === null) return;
    this.answers[this.index] = this.selected;
    this.answered += 1;
    if (this.index + 1 < this.queue.length) {
      this.index += 1;
      this.renderQuestion();
    } else {
      this.finishTest();
    }
  },

  finishTest() {
    this.stopTimer();
    const d = Store.data[cur.id];
    let correct = 0;
    this.queue.forEach((q, i) => {
      const ok = this.answers[i] === q.correctIndex;
      if (ok) correct += 1;
      const p = d.progress[q.id];
      if (ok) p.correctCount += 1; else p.wrongCount += 1;
      p.lastReviewedAt = new Date().toISOString();
    });
    this.sessionCorrect = correct;
    Store.save();
    this.saveSession();
    this.renderTestResults(correct);
    showScreen("done");
  },

  renderTestResults(correct) {
    document.getElementById("done-summary").textContent =
      `${this.queue.length} 問中 ${correct} 問正解（${Math.round((correct / this.queue.length) * 100)}%）`;

    const detail = document.getElementById("done-detail");
    detail.innerHTML = "";

    // 分野別の内訳
    const dTitle = document.createElement("h2");
    dTitle.className = "section-title";
    dTitle.textContent = "分野別の結果";
    detail.appendChild(dTitle);
    const dCard = document.createElement("div");
    dCard.className = "card list-card";
    for (const dn of Object.keys(cur.domains)) {
      const items = this.queue.filter((q) => q.domain === Number(dn));
      if (items.length === 0) continue;
      const ok = items.filter((q) => this.answers[this.queue.indexOf(q)] === q.correctIndex).length;
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span></span><span class="value">${ok}/${items.length}</span>`;
      row.firstElementChild.textContent = cur.domains[dn];
      dCard.appendChild(row);
    }
    detail.appendChild(dCard);

    // 全問の振り返り
    const rTitle = document.createElement("h2");
    rTitle.className = "section-title";
    rTitle.textContent = "振り返り";
    detail.appendChild(rTitle);
    const rCard = document.createElement("div");
    rCard.className = "card";
    this.queue.forEach((q, i) => {
      const mine = this.answers[i];
      const ok = mine === q.correctIndex;
      const item = document.createElement("div");
      item.className = "review-item";
      const head = document.createElement("p");
      head.className = `q-result ${ok ? "ok" : "ng"}`;
      head.textContent = `${ok ? "○ 正解" : "✕ 不正解"}（${domainName(cur, q.domain)}）`;
      item.appendChild(head);
      const qt = document.createElement("p");
      qt.className = "review-q";
      qt.textContent = q.question;
      item.appendChild(qt);
      const ans = document.createElement("p");
      ans.className = "small";
      ans.textContent = `あなたの回答：${LETTERS[mine]}．${q.choices[mine]}／正解：${LETTERS[q.correctIndex]}．${q.choices[q.correctIndex]}`;
      item.appendChild(ans);
      if (!ok) {
        if (q.wrongNote) {
          const note = document.createElement("p");
          note.className = "wrong-note";
          note.textContent = `つまずきポイント：${q.wrongNote}`;
          item.appendChild(note);
        }
        const ex = document.createElement("p");
        ex.className = "small";
        ex.textContent = q.explanation;
        item.appendChild(ex);
        if (q.source) {
          const src = document.createElement("p");
          src.className = "q-source muted small";
          src.textContent = q.source;
          item.appendChild(src);
        }
      }
      rCard.appendChild(item);
    });
    detail.appendChild(rCard);
  },

  // セッションを保存する。回答0件・30秒未満は記録しない（v1と同一条件）
  saveSession() {
    if (!this.startedAt) return;
    const endedAt = new Date();
    const seconds = Math.floor((endedAt - this.startedAt) / 1000);
    if (this.answered > 0 && seconds >= 30) {
      Store.data[cur.id].sessions.push({
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
    this.stopTimer();
    this.saveSession();
    document.getElementById("done-summary").textContent =
      this.mode === "flashcard"
        ? `${this.queue.length} 枚めくりました（思い出せた ${this.sessionCorrect} 枚）`
        : `${this.queue.length} 問中 ${this.sessionCorrect} 問正解`;
    showScreen("done");
  },

  quit() {
    this.stopTimer();
    if (this.mode === "test") {
      // ミニテストを途中で終了した場合は、回答済みの分だけ回数を記録する
      const d = Store.data[cur.id];
      this.answers.forEach((sel, i) => {
        if (sel === undefined) return;
        const q = this.queue[i];
        const p = d.progress[q.id];
        if (sel === q.correctIndex) p.correctCount += 1; else p.wrongCount += 1;
      });
    }
    this.saveSession();
    renderSubject();
    showScreen("subject");
  },
};

function startPractice(mode, domain) {
  let queue, title;
  const d = Store.data[cur.id];
  if (mode === "review") {
    const ids = dueReviews(cur).map((p) => p.questionID);
    queue = ids.map((id) => cur.questions.find((q) => q.id === id)).filter(Boolean);
    title = "今日の復習";
  } else {
    queue = cur.questions
      .filter((q) => q.domain === domain)
      .sort((a, b) => new Date(d.progress[a.id].dueDate) - new Date(d.progress[b.id].dueDate));
    title = domainName(cur, domain);
  }
  if (queue.length === 0) return;
  Practice.start(mode, queue, title);
}

function startNew() {
  const queue = unattempted(cur).slice(0, TEST_SIZE);
  if (queue.length === 0) return;
  Practice.start("new", queue, "新しい問題");
}

function startWeak() {
  const queue = weakQuestions(cur);
  if (queue.length === 0) return;
  Practice.start("weak", queue, "弱点集中");
}

function startTest() {
  const queue = shuffle(cur.questions).slice(0, TEST_SIZE);
  if (queue.length === 0) return;
  Practice.start("test", queue, "ランダムミニテスト");
}

function startFlashcard() {
  const queue = flashQuestions(cur);
  if (queue.length === 0) return;
  Practice.start("flashcard", queue, "フラッシュカード");
}

// ============================================================
// v3: 間違いノート画面
// ============================================================
function renderNote() {
  const items = wrongQuestions(cur);
  const summary = document.getElementById("note-summary");
  const allBtn = document.getElementById("btn-note-review-all");
  const list = document.getElementById("note-list");
  list.innerHTML = "";

  if (items.length === 0) {
    summary.textContent = "間違えた問題はまだありません。この調子で進めましょう。";
    allBtn.hidden = true;
    return;
  }
  summary.textContent = `${cur.name} で1回以上間違えた問題が ${items.length} 問あります。つまずきポイントを確認して、まとめて復習できます。`;
  allBtn.hidden = false;
  allBtn.textContent = `✎ 間違えた問題をまとめて復習（最大${Math.min(NOTE_SIZE, items.length)}問）`;

  for (const { q, p } of items) {
    const card = document.createElement("div");
    card.className = "card note-item";
    const meta = document.createElement("p");
    meta.className = "q-domain muted";
    meta.textContent = `${domainName(cur, q.domain)} ・ 誤答 ${p.wrongCount} 回（正解 ${p.correctCount} 回）`;
    card.appendChild(meta);
    const qt = document.createElement("p");
    qt.className = "review-q";
    qt.textContent = q.question;
    card.appendChild(qt);
    if (q.wrongNote) {
      const note = document.createElement("p");
      note.className = "wrong-note";
      note.textContent = `つまずきポイント：${q.wrongNote}`;
      card.appendChild(note);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "この問題を復習する";
    btn.addEventListener("click", () => Practice.start("note", [q], "間違いノート"));
    card.appendChild(btn);
    list.appendChild(card);
  }
}

function startNoteReview() {
  const queue = wrongQuestions(cur).slice(0, NOTE_SIZE).map(({ q }) => q);
  if (queue.length === 0) return;
  Practice.start("note", queue, "間違いノート");
}

// ============================================================
// 記録画面
// ============================================================
function renderStats() {
  const box = document.getElementById("st-subjects");
  box.innerHTML = "";
  for (const pack of packs) {
    const d = Store.data[pack.id];
    const t = subjectTotals(pack);

    const title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = pack.name;
    box.appendChild(title);

    const summary = document.createElement("div");
    summary.className = "card list-card";
    summary.innerHTML = `
      <div class="row"><span>累計勉強時間</span><span class="value">${durationString(t.seconds)}</span></div>
      <div class="row"><span>セッション数</span><span class="value">${t.sessionCount} 回</span></div>
      <div class="row"><span>累計回答数</span><span class="value">${t.answered} 問</span></div>
      <div class="row"><span>全体正答率</span><span class="value">${t.accuracy === null ? "—" : Math.round(t.accuracy * 100) + "%"}</span></div>
      <div class="row"><span>復習待ち</span><span class="value">${t.due} 問</span></div>`;
    box.appendChild(summary);

    const dTitle = document.createElement("h2");
    dTitle.className = "section-title";
    dTitle.textContent = "分野別の正答率";
    box.appendChild(dTitle);
    const domainsCard = document.createElement("div");
    domainsCard.className = "card list-card";
    const all = Object.values(d.progress);
    for (const dn of Object.keys(pack.domains)) {
      const items = all.filter((p) => p.domain === Number(dn));
      const att = items.reduce((s, p) => s + attemptsOf(p), 0);
      const cor = items.reduce((s, p) => s + p.correctCount, 0);
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span></span><span class="value"></span>`;
      row.firstElementChild.textContent = pack.domains[dn];
      row.lastElementChild.textContent =
        att === 0 ? "未着手" : `${cor}/${att}（${Math.round((cor / att) * 100)}%）`;
      domainsCard.appendChild(row);
    }
    box.appendChild(domainsCard);
  }

  // 最近のセッション（全科目をまとめて新しい順）
  const sbox = document.getElementById("st-sessions");
  sbox.innerHTML = "";
  const combined = [];
  for (const pack of packs) {
    for (const s of Store.data[pack.id].sessions) combined.push({ pack, s });
  }
  if (combined.length === 0) {
    sbox.innerHTML = `<div class="row"><span class="muted">まだ記録がありません。演習をはじめると自動で記録されます。</span></div>`;
  } else {
    const fmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    combined
      .sort((a, b) => new Date(b.s.startedAt) - new Date(a.s.startedAt))
      .slice(0, 10)
      .forEach(({ pack, s }) => {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span></span><span class="value"></span>`;
        row.firstElementChild.textContent = fmt.format(new Date(s.startedAt));
        row.lastElementChild.textContent =
          `${pack.shortName} ・ ${MODE_LABELS[s.mode] || "演習"} ・ ${durationString(s.durationSeconds)}`;
        sbox.appendChild(row);
      });
  }
}

// ============================================================
// 書き出し / 読み込み（v2スキーマ：全科目を含む。v1形式の読み込みにも対応）
// ============================================================
function subjectExport(pack) {
  const d = Store.data[pack.id];
  const all = Object.values(d.progress);
  const perDomain = {};
  for (const dn of Object.keys(pack.domains)) {
    const items = all.filter((p) => p.domain === Number(dn));
    const att = items.reduce((s, p) => s + attemptsOf(p), 0);
    const cor = items.reduce((s, p) => s + p.correctCount, 0);
    perDomain[pack.domains[dn]] = att === 0 ? 0 : cor / att;
  }
  return {
    name: pack.name,
    sessions: [...d.sessions].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt)),
    progress: all
      .sort((a, b) => a.questionID.localeCompare(b.questionID))
      .map((p) => ({
        questionID: p.questionID,
        domain: p.domain,
        domainName: domainName(pack, p.domain),
        correctCount: p.correctCount,
        wrongCount: p.wrongCount,
        easeFactor: p.easeFactor,
        intervalDays: p.intervalDays,
        repetitions: p.repetitions,
        dueDate: p.dueDate,
        lastReviewedAt: p.lastReviewedAt,
      })),
    summary: {
      totalStudySeconds: d.sessions.reduce((s, x) => s + x.durationSeconds, 0),
      sessionCount: d.sessions.length,
      totalAnswered: all.reduce((s, p) => s + attemptsOf(p), 0),
      totalCorrect: all.reduce((s, p) => s + p.correctCount, 0),
      dueReviewCount: dueReviews(pack).length,
      perDomainAccuracy: perDomain,
    },
  };
}

function buildExportPayload() {
  const subjects = {};
  let totalSeconds = 0, totalSessions = 0, totalAnswered = 0, totalCorrect = 0;
  for (const pack of packs) {
    const ex = subjectExport(pack);
    subjects[pack.id] = ex;
    totalSeconds += ex.summary.totalStudySeconds;
    totalSessions += ex.summary.sessionCount;
    totalAnswered += ex.summary.totalAnswered;
    totalCorrect += ex.summary.totalCorrect;
  }
  return {
    exportedAt: new Date().toISOString(),
    app: "StudyApp",
    version: 2,
    subjects,
    summary: {
      totalStudySeconds: totalSeconds,
      sessionCount: totalSessions,
      totalAnswered,
      totalCorrect,
    },
  };
}

async function exportJSON() {
  const payload = buildExportPayload();
  const text = JSON.stringify(payload, null, 2);
  const file = new File([text], "study-export.json", { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch { /* キャンセル時はダウンロードにフォールバック */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = "study-export.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function applyImport(pack, block) {
  const progress = {};
  for (const p of block.progress) {
    progress[p.questionID] = {
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
  Store.data[pack.id] = { progress, sessions: Array.isArray(block.sessions) ? block.sessions : [] };
  Store.seed(pack);
  Store.saveSubject(pack.id);
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
    // v2形式（subjects を含む）か、v1形式（GH-300単独）かを判定
    let targets = [];
    if (payload && payload.subjects && typeof payload.subjects === "object") {
      for (const [id, block] of Object.entries(payload.subjects)) {
        const pack = packById(id);
        if (pack && block && Array.isArray(block.progress)) targets.push([pack, block]);
      }
    } else if (payload && Array.isArray(payload.progress) && Array.isArray(payload.sessions)) {
      const pack = packById("gh300");
      if (pack) targets = [[pack, payload]];
    }
    if (targets.length === 0) {
      message.textContent = "読み込みに失敗しました：学習ログの形式ではないようです。";
      return;
    }
    if (!window.confirm("現在の進捗と学習記録を、読み込むファイルの内容で置き換えます。よろしいですか？")) {
      return;
    }
    let totalProgress = 0, totalSessions = 0;
    for (const [pack, block] of targets) {
      applyImport(pack, block);
      totalProgress += block.progress.length;
      totalSessions += (block.sessions || []).length;
    }
    message.textContent = `読み込みました（${targets.length}科目・${totalProgress}問分の進捗、セッション${totalSessions}件）。`;
    renderStats();
    renderPortal();
  });
}

// ============================================================
// 初期化
// ============================================================
async function init() {
  try {
    const res = await fetch("questions.json");
    const data = await res.json();
    packs = data.subjects || [];
  } catch {
    document.getElementById("portal-today-text").textContent =
      "問題データ（questions.json）の読み込みに失敗しました。HTTPサーバー経由で開いているか確認してください。";
    return;
  }
  if (packs.length === 0) {
    document.getElementById("portal-today-text").textContent = "科目データがありません。";
    return;
  }
  for (const pack of packs) Store.loadSubject(pack);
  cur = packById(localStorage.getItem(LS_CURRENT)) || packs[0];
  renderPortal();
  showScreen("portal");
}

document.getElementById("btn-start-review").addEventListener("click", () => startPractice("review"));
document.getElementById("btn-back-portal").addEventListener("click", () => { renderPortal(); showScreen("portal"); });
document.getElementById("btn-quit-practice").addEventListener("click", () => Practice.quit());
document.getElementById("btn-done-home").addEventListener("click", () => { renderSubject(); showScreen("subject"); });
document.getElementById("btn-flash-reveal").addEventListener("click", () => Practice.revealFlash());
document.getElementById("btn-test-next").addEventListener("click", () => Practice.testNext());
document.getElementById("btn-next-question").addEventListener("click", () => Practice.nextDefault());
document.querySelectorAll(".btn.grade").forEach((btn) => {
  btn.addEventListener("click", () => Practice.grade(btn.dataset.grade));
});
document.getElementById("tab-home").addEventListener("click", () => { renderPortal(); showScreen("portal"); });
document.getElementById("tab-stats").addEventListener("click", () => { renderStats(); showScreen("stats"); });
document.getElementById("btn-back-subject").addEventListener("click", () => { renderSubject(); showScreen("subject"); });
document.getElementById("btn-note-review-all").addEventListener("click", () => startNoteReview());
document.getElementById("exam-date-input").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) localStorage.setItem(LS_EXAMDATE(cur.id), v);
  else localStorage.removeItem(LS_EXAMDATE(cur.id));
  renderExamCard();
  renderPortal();
});
document.getElementById("btn-exam-clear").addEventListener("click", () => {
  localStorage.removeItem(LS_EXAMDATE(cur.id));
  renderExamCard();
  renderPortal();
});
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
