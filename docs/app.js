// app.js — EMS Companion Phase 1
// 더미 JSON (samples/level1.json, level2.json) 또는 실제 백엔드 호출 결과를
// 동일한 화면(통합 타임라인 + SAMPLE/OPQRST + 품질 평가)으로 렌더링.
//
// 아키텍처 메모:
//   - 시나리오 토글(레벨 1/2)은 데모용 — 더미 JSON 그대로
//   - 음성 업로드는 백엔드 /api/pipeline 호출 — 결과를 동일 스키마로 받아 동일 렌더링
//   - API_BASE 만 바꾸면 원격 배포 백엔드로 전환 가능

// =====================================================================
// 백엔드 연결 설정 (API_BASE + API_KEY)
//
// 우선순위:
//   1) URL 파라미터 ?api=<URL>&key=<TOKEN> 으로 받으면 localStorage 에 저장하고
//      URL 에서는 즉시 제거 (브라우저 히스토리 / 서버 로그에 secret 남지 않게)
//   2) localStorage 에 값이 있으면 그것 사용
//   3) 없으면 호스트명 기반 기본값:
//        - localhost / 127.0.0.1 → http://127.0.0.1:8001 (Python FastAPI 개발)
//        - 그 외 (GitHub Pages 등) → 명시적 ?api= 로 받아야 함, 아니면 안내
//
// 사장님 첫 사용 시 한 번만 다음 URL 로 접속:
//   https://<github-pages>/?api=https://ems-companion-api.xxx.workers.dev&key=<SHARED_SECRET>
// 그 후로는 그냥 https://<github-pages> 만 알면 됨.
// =====================================================================
(function captureConfigFromURL() {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  if (params.has("api")) {
    localStorage.setItem("emsApiBase", params.get("api"));
    params.delete("api");
    changed = true;
  }
  if (params.has("key")) {
    localStorage.setItem("emsApiKey", params.get("key"));
    params.delete("key");
    changed = true;
  }
  if (changed) {
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname +
      (newSearch ? "?" + newSearch : "") +
      window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }
})();

const API_BASE = (() => {
  const stored = localStorage.getItem("emsApiBase");
  if (stored) return stored.replace(/\/$/, "");
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:8001";
  }
  // 기본값을 찍어두되, checkBackendHealth 에서 안내 메시지 표시됨.
  return `${window.location.protocol}//${host}:8001`;
})();

const API_KEY = localStorage.getItem("emsApiKey") || "";

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

// =====================================================================
// 사용자 관리 (다중 사용자 시 누가 만든 기록인지 식별)
//   - localStorage 에 emsUserName 저장
//   - 첫 사용 시 prompt 로 입력 (스킵 가능)
//   - 헤더의 "👤 ..." 클릭으로 변경 가능
//   - 다운로드 파일명·결과 _meta 에 사용자명 포함
// =====================================================================
function getUserName() {
  return localStorage.getItem("emsUserName") || "";
}

function setUserName(name) {
  // 파일명에 들어가니 위험 문자만 _ 로 치환
  const cleaned = (name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
  if (cleaned) {
    localStorage.setItem("emsUserName", cleaned);
  } else {
    localStorage.removeItem("emsUserName");
  }
  refreshUserDisplay();
}

function refreshUserDisplay() {
  const el = document.getElementById("user-display");
  if (!el) return;
  const name = getUserName();
  el.textContent = name || "사용자 미설정 (클릭)";
}

function promptUserName() {
  const current = getUserName();
  const input = window.prompt(
    "사용자 이름을 입력하세요\n(예: 동두천소방서 김OO 소방위)\n\n다운로드 파일·구조화 결과에 표기됩니다.",
    current
  );
  if (input === null) return; // 취소 — 기존값 유지
  setUserName(input);
}

// 페이지 로드 시 한 번 — 미설정이면 잠시 후 입력 받음 (취소하면 그대로 진행)
function ensureUserOnFirstLoad() {
  if (!getUserName()) {
    setTimeout(() => promptUserName(), 800);
  }
}

let currentData = null;
let currentLevel = "level1";

// 녹음 상태
let mediaRecorder = null;
let recordChunks = [];
let recordedBlob = null;
let recordStartTime = 0;
let recordTimerId = null;
let recordStream = null;
let recordElapsedMs = 0; // 일시정지 누적 시간 (재개 시 timer 가 이어서 흐르도록)

// =====================================================================
// 데이터 로드 (데모 시나리오)
// =====================================================================
let isDemoMode = false;

async function loadScenario(level) {
  const res = await fetch(`samples/${level}.json`);
  if (!res.ok) {
    alert(`데이터 로드 실패: samples/${level}.json (${res.status})`);
    return;
  }
  currentLevel = level;
  currentData = await res.json();
  isDemoMode = true;
  renderAll(currentData);
  showResults();
  showDemoBanner(level);
}

// =====================================================================
// 화면 상태 토글 (빈 상태 / 결과 / 데모 띠)
// =====================================================================
function showResults() {
  document.getElementById("results-area").classList.remove("hidden");
  document.getElementById("empty-state").classList.add("hidden");
}

function showEmpty() {
  document.getElementById("results-area").classList.add("hidden");
  document.getElementById("empty-state").classList.remove("hidden");
  hideDemoBanner();
}

function showDemoBanner(level) {
  const banner = document.getElementById("demo-banner");
  const label = document.getElementById("demo-banner-level");
  label.textContent = level === "level1" ? "레벨 1 — 조용한 환경" : "레벨 2 — 다중화자";
  banner.classList.remove("hidden");
}

function hideDemoBanner() {
  document.getElementById("demo-banner").classList.add("hidden");
  isDemoMode = false;
}

function closeDemoMode() {
  hideDemoBanner();
  currentData = null;
  currentLevel = "";
  showEmpty();
}

// 데모 메뉴 토글
function toggleDemoMenu() {
  document.getElementById("demo-menu").classList.toggle("hidden");
}
function hideDemoMenu() {
  document.getElementById("demo-menu").classList.add("hidden");
}

// =====================================================================
// 렌더링 진입점
// =====================================================================
function renderAll(data) {
  renderSummary(data);
  renderTimeline(data);
  renderSample(data);
  renderOpqrst(data);
  renderQuality(data);
  renderMeta(data);
}

// 1. 요약 카드
function renderSummary(data) {
  const report = data.report || {};
  document.getElementById("chief-complaint").textContent = report.chief_complaint || "—";
  document.getElementById("consciousness").textContent = report.consciousness || "—";
  document.getElementById("hospital").textContent = report.hospital || "—";
  document.getElementById("handover").textContent = report.handover || "—";
}

// 2. 통합 타임라인 (이 페이지의 핵심)
//
// 알고리즘:
//   1) integrated_timeline 을 입력 순서 그대로 순회 (LLM 이 transcript 순서대로 만듬)
//   2) lastKnownTime 을 유지하며 carry-forward
//      - time 있으면 그 시간 사용, isInferred=false
//      - time 없고 lastKnownTime 있으면 그 시간 사용, isInferred=true → "~HH:MM 이후" 라벨
//      - time 없고 lastKnownTime 도 없으면 "출동 초기" 그룹
//   3) 연속된 같은 (effectiveTime, isInferred) 그룹을 묶어 한 줄로
//
// 핵심 원칙: carry-forward 는 사실 표시 ("직전 명시 시간 이후") 이지 시간 추측 아님.
function renderTimeline(data) {
  const container = document.getElementById("timeline");
  container.innerHTML = "";

  const timeline = data.integrated_timeline || [];
  if (timeline.length === 0) {
    container.innerHTML = `<p class="text-center text-slate-400 py-8">타임라인 항목이 없습니다.</p>`;
    return;
  }

  // 1) 입력 순서를 보존한 채로 carry-forward.
  let lastKnown = null;
  const annotated = timeline.map(ev => {
    if (ev.time) {
      lastKnown = ev.time;
      return { ev, effectiveTime: ev.time, isInferred: false };
    }
    return { ev, effectiveTime: lastKnown, isInferred: true };
  });

  // 2) 연속된 동일 (effectiveTime, isInferred) 항목을 그룹화.
  //    이렇게 하면 "15:10 [명시] → 15:10 [추정] → 15:11 [명시]" 가 세 그룹으로 갈라져 깔끔.
  const groups = [];
  for (const item of annotated) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last.effectiveTime === item.effectiveTime &&
      last.isInferred === item.isInferred
    ) {
      last.events.push(item.ev);
    } else {
      groups.push({
        effectiveTime: item.effectiveTime,
        isInferred: item.isInferred,
        events: [item.ev],
      });
    }
  }

  // 3) 중앙 척추선
  const spine = document.createElement("div");
  spine.className = "timeline-spine";
  container.appendChild(spine);

  // 4) 그룹별 렌더링
  //    각 요소에 timeline-* 마커 클래스를 부여하여 CSS @media 로 모바일 단일 컬럼화.
  for (const group of groups) {
    const row = document.createElement("div");
    row.className = "timeline-row relative grid grid-cols-2 gap-8 py-3";

    // 시간 라벨
    const timeLabel = document.createElement("div");
    let labelText, labelClass;
    if (group.effectiveTime === null) {
      labelText = "출동 초기";
      labelClass = "bg-slate-400 text-white";
    } else if (group.isInferred) {
      labelText = `~${group.effectiveTime} 이후`;
      labelClass = "bg-white border border-slate-300 text-slate-500";
    } else {
      labelText = group.effectiveTime;
      labelClass = "bg-slate-700 text-white";
    }
    timeLabel.className = `timeline-time-label absolute left-1/2 -translate-x-1/2 -top-1 z-10 px-2.5 py-0.5 text-xs sm:text-sm font-mono font-bold rounded-full shadow-md ${labelClass}`;
    timeLabel.textContent = labelText;
    row.appendChild(timeLabel);

    // 좌우 컬럼
    const leftCol = document.createElement("div");
    leftCol.className = "timeline-left pr-4 space-y-2 text-right";
    const rightCol = document.createElement("div");
    rightCol.className = "timeline-right pl-4 space-y-2 text-left";

    for (const ev of group.events) {
      const card = makeEventCard(ev, group.isInferred, data);
      if (ev.type === "patient_speech") {
        leftCol.appendChild(card);
      } else {
        rightCol.appendChild(card);
      }
    }

    row.appendChild(leftCol);
    row.appendChild(rightCol);
    container.appendChild(row);
  }
}

// ---------- 헬퍼: patient_speech_track 에서 같은 발화 찾아 tags 가져오기 ----------
function findSpeechTags(ev, allData) {
  if (!allData || ev.type !== "patient_speech") return [];
  const speeches = allData.patient_speech_track || [];
  // 1차: time + content 정확 일치
  for (const sp of speeches) {
    if (sp.time === ev.time && sp.content === ev.content) {
      return sp.tags || [];
    }
  }
  // 2차: content 정확 일치만 (time 다를 수 있음)
  for (const sp of speeches) {
    if (sp.content === ev.content) {
      return sp.tags || [];
    }
  }
  return [];
}

// ---------- 헬퍼: 활력징후 content 에서 수치 추출 (BP/HR/RR/SpO2/Temp/GCS/BST) ----------
function parseVitals(content) {
  if (!content) return null;
  const vitals = {};
  // 혈압 "160/95", "160에 95", "160 / 95" 등
  let m = content.match(/혈압[^\d]*(\d{2,3})\s*(?:\/|에|on)\s*(\d{2,3})/);
  if (m) vitals.BP = `${m[1]}/${m[2]}`;
  // 맥박 "110" (3자리까지)
  m = content.match(/맥박[^\d]*(\d{2,3})/);
  if (m) vitals.HR = m[1];
  // 호흡 "22" "호흡수 22"
  m = content.match(/호흡(?:수)?[^\d]*(\d{1,3})/);
  if (m) vitals.RR = m[1];
  // 산소포화도 "94%" "94" "SpO2 94"
  m = content.match(/(?:산소포화도|SpO2|spo2)[^\d]*(\d{2,3})/);
  if (m) vitals.SpO2 = m[1];
  // 체온 "36.8" "36도 8" "36도8"
  m = content.match(/체온[^\d]*(\d{2})(?:[.도\s]+(\d))?/);
  if (m) vitals.Temp = m[2] ? `${m[1]}.${m[2]}` : m[1];
  // 혈당 "38", "혈당 38", "BST 38"
  m = content.match(/(?:혈당|BST|bst)[^\d]*(\d{2,3})/);
  if (m) vitals.BST = m[1];
  // GCS "15", "GCS 15점"
  m = content.match(/GCS[^\d]*(\d{1,2})/i);
  if (m) vitals.GCS = m[1];
  return Object.keys(vitals).length > 0 ? vitals : null;
}

function makeEventCard(ev, isInferred = false, allData = null) {
  const isPatient = ev.type === "patient_speech";
  const card = document.createElement("div");

  // 추정 시간(isInferred)이면 테두리를 점선(border-dashed)으로 + 살짝 흐리게.
  const borderStyle = isInferred ? "border-dashed opacity-90" : "";

  // 환자 발화 — 의식수준_변화 태그가 있으면 별 강조 + 약간 더 진한 테두리
  let extraClass = "";
  let tags = [];
  if (isPatient) {
    tags = findSpeechTags(ev, allData);
    const hasConsciousness = tags.includes("의식수준_변화");
    extraClass = hasConsciousness ? "ring-2 ring-amber-400 dark:ring-amber-500/60" : "";
    card.className = `timeline-card inline-block max-w-full bg-amber-50 border border-amber-200 ${borderStyle} ${extraClass} rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100`;
  } else {
    const palette = {
      vitals: "bg-blue-50 border-blue-200",
      medication: "bg-emerald-50 border-emerald-200",
      procedure: "bg-cyan-50 border-cyan-200",
      observation: "bg-slate-50 border-slate-200",
    };
    const tone = palette[ev.type] || palette.observation;
    card.className = `timeline-card inline-block max-w-full ${tone} border ${borderStyle} rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100`;
  }

  // 타입별 아이콘 + 라벨
  const typeMeta = {
    patient_speech: { icon: "💬", label: "발화" },
    vitals:         { icon: "🩺", label: "활력징후" },
    medication:     { icon: "💊", label: "약물" },
    procedure:      { icon: "🔧", label: "술기" },
    observation:    { icon: "👁️", label: "관찰" },
  }[ev.type] || { icon: "•", label: ev.type };

  const actorBadge = ev.actor
    ? `<span class="inline-block mr-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-white/70 dark:bg-slate-900/40 text-slate-600 dark:text-slate-300">${escapeHtml(ev.actor)}</span>`
    : "";

  // 의식수준_변화 태그 별 표시 (헤더에)
  const consciousnessBadge = tags.includes("의식수준_변화")
    ? `<span class="inline-block ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded bg-amber-400 text-white" title="의식수준 변화 marker — 임상적으로 중요">⭐ 의식변화</span>`
    : "";

  // 활력징후 수치 그리드 (vitals 카드에서만)
  let vitalsGrid = "";
  if (ev.type === "vitals") {
    const v = parseVitals(ev.content);
    if (v) {
      const items = [];
      if (v.BP)   items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">BP</span> <span class="font-bold">${v.BP}</span></span>`);
      if (v.HR)   items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">HR</span> <span class="font-bold">${v.HR}</span></span>`);
      if (v.RR)   items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">RR</span> <span class="font-bold">${v.RR}</span></span>`);
      if (v.SpO2) items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">SpO₂</span> <span class="font-bold">${v.SpO2}%</span></span>`);
      if (v.Temp) items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">T</span> <span class="font-bold">${v.Temp}°</span></span>`);
      if (v.BST)  items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">BST</span> <span class="font-bold">${v.BST}</span></span>`);
      if (v.GCS)  items.push(`<span class="font-mono"><span class="text-[10px] text-slate-500 dark:text-slate-400">GCS</span> <span class="font-bold">${v.GCS}</span></span>`);
      if (items.length > 0) {
        vitalsGrid = `<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-sm">${items.join("")}</div>`;
      }
    }
  }

  card.innerHTML = `
    <div class="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
      <span class="text-sm leading-none">${typeMeta.icon}</span>
      ${actorBadge}<span>${escapeHtml(typeMeta.label)}</span>${consciousnessBadge}
    </div>
    <div class="leading-snug">${escapeHtml(ev.content || "")}</div>
    ${vitalsGrid}
  `;
  return card;
}

// 3. SAMPLE
function renderSample(data) {
  const sample = data.sample || {};
  const labels = {
    S: "S · 증상",
    A: "A · 알레르기",
    M: "M · 약물",
    P: "P · 과거력",
    L: "L · 마지막식사",
    E: "E · 사건경위",
  };
  renderKeyValueList("sample-list", labels, sample);
}

// 4. OPQRST
function renderOpqrst(data) {
  const opqrst = data.opqrst || {};
  const labels = {
    O: "O · 발병",
    P: "P · 악화/완화",
    Q: "Q · 양상",
    R: "R · 방사",
    S: "S · 강도",
    T: "T · 시간경과",
  };
  renderKeyValueList("opqrst-list", labels, opqrst);
}

function renderKeyValueList(elId, labels, data) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  for (const [k, label] of Object.entries(labels)) {
    const val = data[k];
    const item = document.createElement("div");
    item.className = "flex items-start gap-3 border-b border-slate-100 pb-2 last:border-0";
    item.innerHTML = `
      <dt class="w-28 shrink-0 text-xs font-semibold text-slate-500 pt-0.5">${escapeHtml(label)}</dt>
      <dd class="flex-1 text-slate-800">${val ? escapeHtml(val) : '<span class="text-slate-300 italic">추출 없음</span>'}</dd>
    `;
    el.appendChild(item);
  }
}

// 5. 품질 평가
function renderQuality(data) {
  const qa = data.quality_assessment || {};
  renderQualityList("qa-hallucination", qa.hallucination_suspected || []);
  renderQualityList("qa-omission", qa.omission_suspected || []);
  renderQualityList("qa-terminology", qa.terminology_errors || []);
  renderQualityList("qa-notes", qa.notes || []);
}

function renderQualityList(elId, items) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  if (items.length === 0) {
    el.innerHTML = `<li class="text-slate-400 italic">없음</li>`;
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "before:content-['•'] before:mr-2 before:text-slate-400";
    li.textContent = item;
    el.appendChild(li);
  }
}

// 6. 메타
function renderMeta(data) {
  const meta = data._meta || {};
  const el = document.getElementById("meta-info");
  if (!meta.model) {
    el.textContent = "";
    return;
  }
  el.textContent = `${meta.model} · ${meta.timestamp || ""}`;
}

// =====================================================================
// 유틸
// =====================================================================
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// =====================================================================
// 다운로드
// =====================================================================
function buildFileName(suffix) {
  // 예: EMS_김OO_2026-05-22_14-32_report.md
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const userPart = getUserName() ? `_${getUserName()}` : "";
  const sourcePart = currentLevel && currentLevel !== "level1" && currentLevel !== "level2"
    ? "" // 실음성이면 사용자명만으로 충분
    : `_${currentLevel}`; // 데모 시나리오면 시나리오명 포함
  return `EMS${userPart}${sourcePart}_${stamp}_${suffix}`;
}

function downloadJson() {
  if (!currentData) {
    alert("다운로드할 데이터가 없습니다.");
    return;
  }
  // 다운로드 직전에 사용자 정보를 _meta 에 한 번 더 박아둠 (파일만 봐도 식별 가능)
  const dataWithUser = {
    ...currentData,
    _meta: {
      ...(currentData._meta || {}),
      recorded_by: getUserName() || null,
      session_source: currentLevel,
      downloaded_at: new Date().toISOString(),
    },
  };
  const blob = new Blob([JSON.stringify(dataWithUser, null, 2)], { type: "application/json" });
  triggerDownload(blob, buildFileName("structured.json"));
}

function downloadMarkdown() {
  if (!currentData) {
    alert("다운로드할 데이터가 없습니다.");
    return;
  }
  const md = buildMarkdown(currentData);
  const blob = new Blob([md], { type: "text/markdown" });
  triggerDownload(blob, buildFileName("report.md"));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function buildMarkdown(data) {
  // 브라우저에서도 사람이 읽기 좋은 마크다운으로 export (structure.py 의 to_markdown 과 동등)
  const lines = [];
  const report = data.report || {};
  lines.push(`# 🚒 구급 출동 구조화 리포트`);
  lines.push("");
  const userName = getUserName();
  if (userName) lines.push(`- **기록자:** ${userName}`);
  lines.push(`- **시나리오:** ${currentLevel}`);
  if (data._meta) {
    lines.push(`- **모델:** ${data._meta.model || "N/A"}`);
    lines.push(`- **생성 시각:** ${data._meta.timestamp || "N/A"}`);
  }
  lines.push(`- **다운로드 시각:** ${new Date().toLocaleString("ko-KR")}`);
  lines.push("");

  lines.push("## 통합 타임라인");
  lines.push("");
  lines.push("| 시간 | 구분 | 주체 | 내용 |");
  lines.push("|------|------|------|------|");
  for (const ev of data.integrated_timeline || []) {
    lines.push(`| ${ev.time || "-"} | ${ev.type || "-"} | ${ev.actor || "-"} | ${(ev.content || "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("");

  lines.push("## 구급일지 핵심 요약");
  lines.push(`- **주증상:** ${report.chief_complaint || "—"}`);
  lines.push(`- **의식수준:** ${report.consciousness || "—"}`);
  lines.push(`- **이송 병원:** ${report.hospital || "—"}`);
  lines.push(`- **인계 사항:** ${report.handover || "—"}`);

  return lines.join("\n");
}

// =====================================================================
// 출동 종료 / 데이터 정리
// =====================================================================
function showEndSessionModal() {
  if (!currentData) {
    // 화면에 표시된 출동 데이터가 없으면 종료할 게 없음
    alert("현재 화면에 표시된 출동 데이터가 없습니다.\n(데모 시나리오는 종료 대상이 아닙니다.)");
    return;
  }
  document.getElementById("modal-end-session").classList.remove("hidden");
  document.getElementById("modal-end-session").classList.add("flex");
}

function hideEndSessionModal() {
  const el = document.getElementById("modal-end-session");
  el.classList.add("hidden");
  el.classList.remove("flex");
}

function resetScreen() {
  // 출동 종료 후 빈 상태로 (API/사용자 설정은 유지)
  currentData = null;
  currentLevel = "";
  showEmpty();
  // 입력 영역 초기화
  document.getElementById("audio-file").value = "";
  if (typeof resetRecording === "function") resetRecording();
}

function endSessionWithDownload() {
  // 데이터가 실음성에서 온 게 아니면 (데모) 그냥 클리어. 실음성이면 다운로드 후 클리어.
  const isRealSession = !["level1", "level2"].includes(currentLevel);
  if (isRealSession && currentData) {
    try {
      downloadJson();
      downloadMarkdown();
    } catch (e) {
      console.error(e);
      const ok = confirm(`다운로드 중 오류 발생: ${e.message}\n그래도 화면을 초기화할까요?`);
      if (!ok) return;
    }
  }
  resetScreen();
  hideEndSessionModal();
}

function endSessionDiscard() {
  const ok = confirm("정말 다운로드 없이 삭제하시겠습니까?\n복구할 수 없습니다.");
  if (!ok) return;
  resetScreen();
  hideEndSessionModal();
}

function clearAllLocalData() {
  const ok = confirm(
    "⚠️ 완전 삭제 — 다음 항목이 모두 지워집니다:\n\n" +
    "  • 사용자 이름\n" +
    "  • 백엔드 URL (API_BASE)\n" +
    "  • 인증 토큰 (SHARED_SECRET)\n" +
    "  • 현재 출동 데이터\n\n" +
    "다음에 사용하시려면 ?api=&key= URL 로 다시 접속하셔야 합니다.\n\n계속하시겠습니까?"
  );
  if (!ok) return;
  localStorage.removeItem("emsUserName");
  localStorage.removeItem("emsApiBase");
  localStorage.removeItem("emsApiKey");
  resetScreen();
  hideEndSessionModal();
  alert("모든 로컬 데이터가 삭제되었습니다.\n페이지를 새로고침합니다.");
  // 페이지 새로고침 (메모리상의 API_BASE/API_KEY 도 초기화)
  setTimeout(() => window.location.reload(), 300);
}

// =====================================================================
// 백엔드 호출
// =====================================================================
async function checkBackendHealth() {
  const el = document.getElementById("backend-status");
  try {
    const res = await fetch(`${API_BASE}/health`, {
      method: "GET",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const shortBase = API_BASE.replace(/^https?:\/\//, "");
    if (!data.openai_key_configured) {
      el.innerHTML = `<span class="text-amber-600">● 백엔드 OK · OPENAI_API_KEY 없음</span>`;
    } else if (data.auth_required && !API_KEY) {
      el.innerHTML = `<span class="text-amber-600">● 백엔드 OK · 인증 토큰 필요 (?key= 로 한 번 접속)</span>`;
    } else {
      el.innerHTML = `<span class="text-emerald-600" title="${shortBase}">● 연결됨</span>`;
    }
  } catch (e) {
    el.innerHTML = `<span class="text-rose-500" title="${API_BASE}">● 응답 없음</span>`;
  }
}

// ---------------------------------------------------------------------
// 녹음 (MediaRecorder)
// ---------------------------------------------------------------------
function pickRecorderMime() {
  // 브라우저별 지원 codec 우선순위. gpt-4o-transcribe 가 받는 형식.
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function elapsedMsNow() {
  // 현재까지 누적 녹음 시간 (일시정지 동안은 멈춤)
  if (mediaRecorder && mediaRecorder.state === "recording") {
    return recordElapsedMs + (Date.now() - recordStartTime);
  }
  return recordElapsedMs;
}

function startTimer() {
  if (recordTimerId) return;
  recordTimerId = setInterval(() => {
    document.getElementById("record-timer").textContent = formatElapsed(elapsedMsNow());
  }, 250);
}

function stopTimer() {
  if (recordTimerId) {
    clearInterval(recordTimerId);
    recordTimerId = null;
  }
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert("이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다. Chrome/Edge 최신 버전을 사용해주세요.");
    return;
  }

  try {
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("마이크 권한이 거부되었거나 사용 불가합니다: " + (e.message || e));
    return;
  }

  const mime = pickRecorderMime();
  const opts = mime ? { mimeType: mime } : undefined;
  mediaRecorder = new MediaRecorder(recordStream, opts);
  recordChunks = [];
  recordedBlob = null;
  recordElapsedMs = 0;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blobType = mediaRecorder.mimeType || "audio/webm";
    recordedBlob = new Blob(recordChunks, { type: blobType });

    // UI: 미리듣기, 다시 녹음 버튼
    const preview = document.getElementById("record-preview");
    preview.src = URL.createObjectURL(recordedBlob);
    preview.classList.remove("hidden");
    document.getElementById("btn-rerecord").classList.remove("hidden");

    document.getElementById("btn-record-label").textContent = "● 녹음 시작";
    document.getElementById("btn-record").classList.remove("bg-slate-700");
    document.getElementById("btn-record").classList.add("bg-rose-600");

    // 일시정지 버튼 숨김
    document.getElementById("btn-pause").classList.add("hidden");
    document.getElementById("btn-pause-label").textContent = "⏸ 일시정지";

    // 파일 입력 초기화 (입력 소스는 녹음으로 통일)
    document.getElementById("audio-file").value = "";

    updateInputSummary();

    // 마이크 stream 정리
    if (recordStream) {
      recordStream.getTracks().forEach(t => t.stop());
      recordStream = null;
    }
  };

  mediaRecorder.start();
  recordStartTime = Date.now();
  startTimer();

  // 버튼 토글: 정지 모드로 + 일시정지 노출
  document.getElementById("btn-record-label").textContent = "■ 정지";
  document.getElementById("btn-record").classList.remove("bg-rose-600");
  document.getElementById("btn-record").classList.add("bg-slate-700");
  document.getElementById("btn-pause").classList.remove("hidden");
  document.getElementById("btn-pause-label").textContent = "⏸ 일시정지";
  document.getElementById("record-hint").textContent = "녹음 중… 정지를 누르면 끝납니다.";

  // 기존 녹음 미리듣기는 숨김
  document.getElementById("record-preview").classList.add("hidden");
  document.getElementById("btn-rerecord").classList.add("hidden");
}

function pauseRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.pause();
  // 누적 시간 갱신
  recordElapsedMs += Date.now() - recordStartTime;
  stopTimer();
  document.getElementById("btn-pause-label").textContent = "▶ 재개";
  document.getElementById("record-hint").textContent = "⏸ 일시정지 중. 마이크 차단됨. '재개' 시 이어서 녹음됩니다.";
}

function resumeRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "paused") return;
  mediaRecorder.resume();
  recordStartTime = Date.now();
  startTimer();
  document.getElementById("btn-pause-label").textContent = "⏸ 일시정지";
  document.getElementById("record-hint").textContent = "녹음 중… 정지를 누르면 끝납니다.";
}

function togglePause() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === "recording") pauseRecording();
  else if (mediaRecorder.state === "paused") resumeRecording();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    // paused 상태에서 정지하는 경우도 누적시간 보존
    if (mediaRecorder.state === "recording") {
      recordElapsedMs += Date.now() - recordStartTime;
    }
    mediaRecorder.stop();
  }
  stopTimer();
  document.getElementById("record-hint").textContent = "녹음 완료. 미리듣기 후 '처리 시작'을 누르세요.";
}

function toggleRecording() {
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
    stopRecording();
  } else {
    startRecording();
  }
}

function resetRecording() {
  recordedBlob = null;
  recordChunks = [];
  recordElapsedMs = 0;
  document.getElementById("record-preview").classList.add("hidden");
  document.getElementById("record-preview").src = "";
  document.getElementById("btn-rerecord").classList.add("hidden");
  document.getElementById("record-timer").textContent = "00:00";
  document.getElementById("record-hint").textContent = "처음 사용 시 마이크 권한을 허용해주세요.";
  updateInputSummary();
}

// ---------------------------------------------------------------------
// 입력 소스 통합 (파일 vs 녹음)
// ---------------------------------------------------------------------
function getActiveInput() {
  // 우선순위: 녹음 결과가 있으면 그것, 아니면 파일.
  if (recordedBlob) {
    return {
      kind: "recording",
      blob: recordedBlob,
      filename: `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
      sizeMb: (recordedBlob.size / (1024 * 1024)).toFixed(2),
    };
  }
  const fileInput = document.getElementById("audio-file");
  if (fileInput.files && fileInput.files.length > 0) {
    const f = fileInput.files[0];
    return {
      kind: "file",
      blob: f,
      filename: f.name,
      sizeMb: (f.size / (1024 * 1024)).toFixed(2),
    };
  }
  return null;
}

function updateInputSummary() {
  const summaryEl = document.getElementById("input-summary");
  const btn = document.getElementById("btn-process");
  const input = getActiveInput();
  if (!input) {
    summaryEl.textContent = "아직 입력 없음";
    btn.disabled = true;
    return;
  }
  const kindLabel = input.kind === "recording" ? "🎤 직접 녹음" : "📁 파일";
  summaryEl.textContent = `${kindLabel} · ${input.filename} (${input.sizeMb} MB)`;
  btn.disabled = false;
}

// ---------------------------------------------------------------------
// 자동 무음 제거 (Web Audio API, 클라이언트 단)
// ---------------------------------------------------------------------
// 흐름: Blob → AudioBuffer(decode) → RMS 분석으로 발화 구간 식별
//       → 발화 구간만 concat → WAV(16-bit PCM)로 인코딩 → 새 Blob
//
// 설계 결정:
//   - 임계값 / 윈도우 크기는 보수적 (짧은 무음은 발화에 흡수, padding 100ms)
//   - 모노로 통일 (STT 입력은 모노로 충분)
//   - 원본 sampleRate 유지 (다운샘플링은 별도 작업)
//   - 처리 실패 시 원본 그대로 폴백
async function decodeBlobToAudioBuffer(blob) {
  const arrBuf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrBuf);
  } finally {
    if (ctx.close) ctx.close();
  }
}

function detectVoiceSegments(audioBuffer, opts = {}) {
  const {
    windowMs = 20,
    threshold = 0.01,    // RMS 임계값 (정규화 -1~1). 보수적.
    minSilenceMs = 500,  // 이 이상 연속 무음만 잘라냄. 짧은 침묵은 보존.
    paddingMs = 100,     // 발화 구간 앞뒤로 약간 보존 (어색함 방지)
  } = opts;

  const sampleRate = audioBuffer.sampleRate;
  // 모노로 합산(또는 첫 채널) — 단순화
  const ch = audioBuffer.getChannelData(0);
  const windowSize = Math.max(1, Math.floor(sampleRate * windowMs / 1000));

  // 윈도우별 voice 플래그
  const flags = [];
  for (let i = 0; i < ch.length; i += windowSize) {
    const end = Math.min(i + windowSize, ch.length);
    let sum = 0;
    for (let j = i; j < end; j++) sum += ch[j] * ch[j];
    const rms = Math.sqrt(sum / (end - i));
    flags.push(rms > threshold);
  }
  if (flags.length === 0) return [];

  // 연속 구간 분할
  const rawSegs = [];
  let curStart = 0;
  let curIsVoice = flags[0];
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] !== curIsVoice) {
      rawSegs.push({ start: curStart * windowSize, end: i * windowSize, isVoice: curIsVoice });
      curStart = i;
      curIsVoice = flags[i];
    }
  }
  rawSegs.push({ start: curStart * windowSize, end: Math.min(flags.length * windowSize, ch.length), isVoice: curIsVoice });

  // 짧은 무음은 앞 voice 구간에 흡수
  const minSilenceSamples = Math.floor(sampleRate * minSilenceMs / 1000);
  const merged = [];
  for (const seg of rawSegs) {
    const len = seg.end - seg.start;
    if (!seg.isVoice && len < minSilenceSamples && merged.length > 0 && merged[merged.length - 1].isVoice) {
      merged[merged.length - 1].end = seg.end;
    } else if (merged.length > 0 && merged[merged.length - 1].isVoice === seg.isVoice) {
      merged[merged.length - 1].end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }

  // voice 구간만, 앞뒤 padding 추가, 인접 voice 끼리 다시 병합
  const paddingSamples = Math.floor(sampleRate * paddingMs / 1000);
  const voiceSegs = merged
    .filter(s => s.isVoice)
    .map(s => ({
      start: Math.max(0, s.start - paddingSamples),
      end: Math.min(ch.length, s.end + paddingSamples),
    }));

  // padding으로 인접 구간이 겹치면 병합
  const finalSegs = [];
  for (const seg of voiceSegs) {
    if (finalSegs.length > 0 && seg.start <= finalSegs[finalSegs.length - 1].end) {
      finalSegs[finalSegs.length - 1].end = Math.max(finalSegs[finalSegs.length - 1].end, seg.end);
    } else {
      finalSegs.push({ ...seg });
    }
  }
  return finalSegs;
}

function concatVoiceSamples(audioBuffer, segments) {
  const ch = audioBuffer.getChannelData(0);
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const seg of segments) {
    out.set(ch.subarray(seg.start, seg.end), offset);
    offset += seg.end - seg.start;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  // 16-bit PCM mono WAV
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // RIFF header
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  // fmt chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);            // chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);            // bits per sample
  // data chunk
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s | 0, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function removeSilenceFromBlob(blob) {
  // 실패 시 원본 그대로 반환(폴백). 사장님 비용은 약간 더 들겠지만 동작은 유지.
  try {
    const audioBuffer = await decodeBlobToAudioBuffer(blob);
    const originalSec = audioBuffer.duration;
    const segments = detectVoiceSegments(audioBuffer);
    if (segments.length === 0) {
      // 전부 무음으로 판정되면 원본 반환 (안전)
      return { blob, originalSec, trimmedSec: originalSec, skipped: true };
    }
    const samples = concatVoiceSamples(audioBuffer, segments);
    const wavBlob = encodeWav(samples, audioBuffer.sampleRate);
    const trimmedSec = samples.length / audioBuffer.sampleRate;
    return { blob: wavBlob, originalSec, trimmedSec, skipped: false };
  } catch (e) {
    console.warn("무음 제거 실패, 원본 사용:", e);
    return { blob, originalSec: 0, trimmedSec: 0, skipped: true };
  }
}

async function processAudio() {
  const modelSelect = document.getElementById("model-select");
  const btn = document.getElementById("btn-process");
  const statusEl = document.getElementById("process-status");
  const statusText = document.getElementById("process-status-text");
  const autoVad = document.getElementById("auto-vad").checked;

  const input = getActiveInput();
  if (!input) {
    alert("녹음을 하거나 파일을 선택해주세요.");
    return;
  }

  // UI 잠금
  btn.disabled = true;
  statusEl.classList.remove("hidden");

  let uploadBlob = input.blob;
  let uploadFilename = input.filename;
  let uploadSizeMb = input.sizeMb;
  let vadInfo = "";

  // 자동 무음 제거 (체크박스 ON 이고 직접 녹음일 때만 적용)
  if (autoVad && input.kind === "recording") {
    statusText.textContent = `🔇 무음 구간 분석 중…`;
    const result = await removeSilenceFromBlob(input.blob);
    if (!result.skipped) {
      uploadBlob = result.blob;
      // WAV 로 바뀌었으므로 확장자 교체
      uploadFilename = uploadFilename.replace(/\.[^.]+$/, "") + "_trimmed.wav";
      uploadSizeMb = (uploadBlob.size / (1024 * 1024)).toFixed(2);
      const savedSec = (result.originalSec - result.trimmedSec).toFixed(1);
      const ratio = result.originalSec > 0
        ? Math.round((1 - result.trimmedSec / result.originalSec) * 100)
        : 0;
      vadInfo = ` · 무음 제거: ${result.originalSec.toFixed(1)}s → ${result.trimmedSec.toFixed(1)}s (-${savedSec}s, -${ratio}%)`;
    }
  }

  statusText.textContent = `업로드 중… (${uploadFilename}, ${uploadSizeMb} MB)${vadInfo}`;

  const form = new FormData();
  form.append("audio", uploadBlob, uploadFilename);
  const params = new URLSearchParams({ model: modelSelect.value });

  const t0 = performance.now();
  try {
    statusText.textContent = `STT 변환 + 구조화 진행 중… (보통 30~60초 소요)`;
    const res = await fetch(`${API_BASE}/api/pipeline?${params}`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`HTTP ${res.status}: ${errBody}`);
    }

    const json = await res.json();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    // 백엔드 응답: { transcribe: {...}, structured: {...} }
    currentData = json.structured;
    currentLevel = input.kind === "recording" ? "recording" : `upload_${input.filename}`;
    renderAll(currentData);

    // 실 데이터로 전환 → 데모 띠 / 빈 상태 안내 숨김, 결과 영역 표시
    hideDemoBanner();
    showResults();

    statusText.innerHTML = `<span class="text-emerald-600">✓ 완료 (${elapsed}초).${vadInfo} 화면이 입력한 음성의 결과로 업데이트됐습니다.</span>`;
  } catch (e) {
    console.error(e);
    statusText.innerHTML = `<span class="text-rose-600">✗ 실패: ${escapeHtml(e.message || String(e))}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// =====================================================================
// 초기화
// =====================================================================
// 데모 메뉴 (헤더 우측 "📚 데모" 버튼)
document.getElementById("btn-demo").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleDemoMenu();
});
document.querySelectorAll(".demo-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    const level = btn.getAttribute("data-demo");
    hideDemoMenu();
    loadScenario(level);
  });
});
document.getElementById("btn-demo-close").addEventListener("click", closeDemoMode);
// 메뉴 바깥 클릭 시 메뉴 닫기
document.addEventListener("click", (e) => {
  const menu = document.getElementById("demo-menu");
  if (!menu.classList.contains("hidden")) {
    if (!menu.contains(e.target) && e.target.id !== "btn-demo") {
      hideDemoMenu();
    }
  }
});

document.getElementById("btn-download-json").addEventListener("click", downloadJson);
document.getElementById("btn-download-md").addEventListener("click", downloadMarkdown);
document.getElementById("btn-process").addEventListener("click", processAudio);
document.getElementById("btn-record").addEventListener("click", toggleRecording);
document.getElementById("btn-pause").addEventListener("click", togglePause);
document.getElementById("btn-rerecord").addEventListener("click", resetRecording);

// 다크 모드 토글
//   - 초기 적용은 <head> 의 인라인 스크립트가 FOUC 방지 위해 처리
//   - 여기서는 토글 + localStorage 저장
document.getElementById("btn-theme").addEventListener("click", () => {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("emsTheme", isDark ? "dark" : "light");
});

// 사용자 / 출동 종료
document.getElementById("btn-user").addEventListener("click", promptUserName);
document.getElementById("btn-end-session").addEventListener("click", showEndSessionModal);
document.getElementById("btn-end-download").addEventListener("click", endSessionWithDownload);
document.getElementById("btn-end-discard").addEventListener("click", endSessionDiscard);
document.getElementById("btn-end-cancel").addEventListener("click", hideEndSessionModal);
document.getElementById("btn-clear-all").addEventListener("click", clearAllLocalData);

// 모달 배경(검은 영역) 클릭 시 닫기 — 단, 패널 내부 클릭은 닫지 않음
document.getElementById("modal-end-session").addEventListener("click", (e) => {
  if (e.target.id === "modal-end-session") hideEndSessionModal();
});

// ESC 키로 모달 닫기
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideEndSessionModal();
});

// 파일 선택 변경 시 입력 요약 갱신 + 녹음이 있으면 그것 우선이므로
// 새 파일이 들어오면 녹음 결과는 지우는 게 직관적.
document.getElementById("audio-file").addEventListener("change", () => {
  // 파일이 새로 선택되면 기존 녹음을 비움
  if (document.getElementById("audio-file").files.length > 0 && recordedBlob) {
    resetRecording();
  } else {
    updateInputSummary();
  }
});

checkBackendHealth();
// 첫 로드는 빈 상태로 시작 (데모 자동 로드 X — 실 사용 모드 우선)
showEmpty();
updateInputSummary();
refreshUserDisplay();
ensureUserOnFirstLoad();
