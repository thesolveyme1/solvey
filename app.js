import {
    YEAR5_MODULES,
    CATEGORY_LABELS,
    SYNC_CHANNEL_NAME,
    extractQuestions,
    getQuestionId,
    resolveMediaPath,
    hasArabic,
    getIDBCache
} from "./data-catalog.js";
import { saveFirebaseConfigOverride } from "./firebase-config.js";
import {
    loadLocalStore,
    createCloudBridge,
    formatDuration
} from "./store.js";

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

const appState = {
    activeNav: "home",
    category: "all",
    search: "",
    store: loadLocalStore(),
    modulesCache: {},    // { modKey: rawTree }
    cloudChecked: {},    // { modKey: true }
    setup: null,         // { mod, lessons: [{ key, label }], selectedLessons: Set, search, settings }
    session: null,       // active quiz session
    results: null,       // current viewed session result
    resultsFilter: "all",
    timerInterval: null
};

const cloud = createCloudBridge({
    onUserChanged: () => updateAuthUI(),
    onDataMerged: (remote) => {
        const s = appState.store;
        if (remote.answered) s.answered = Object.assign({}, remote.answered, s.answered);
        if (remote.wrongCounts) s.wrongCounts = Object.assign({}, remote.wrongCounts, s.wrongCounts);
        if (remote.attemptCounts) s.attemptCounts = Object.assign({}, remote.attemptCounts, s.attemptCounts);
        if (remote.bookmarked) s.bookmarked = Object.assign({}, remote.bookmarked, s.bookmarked);
        if (remote.notes) s.notes = Object.assign({}, remote.notes, s.notes);
        if (Array.isArray(remote.presets) && s.presets.length === 0) s.presets = remote.presets;
        if (Array.isArray(remote.history) && remote.history.length > (s.history || []).length) {
            s.history = remote.history;
        }
        if (Array.isArray(remote.pendingSessions) && s.pendingSessions.length === 0) {
            s.pendingSessions = remote.pendingSessions;
        }
        if (typeof remote.totalSeconds === "number" && remote.totalSeconds > (s.totalSeconds || 0)) {
            s.totalSeconds = remote.totalSeconds;
        }
        cloud.scheduleSync(s);
        renderHome();
        if (appState.activeNav === "history") renderHistory();
        if (appState.activeNav === "favorites") renderFavorites();
        if (appState.activeNav === "mistakes") renderMistakes();
        if (appState.activeNav === "stats") renderStats();
    }
});

/* ---------------- Navigation & Topbar ---------------- */

function setView(viewId) {
    document.querySelectorAll(".view").forEach((el) => el.classList.remove("is-active"));
    const target = document.getElementById(viewId);
    if (target) target.classList.add("is-active");

    const isQuestion = viewId === "view-question";
    document.getElementById("main-topbar").style.display = isQuestion ? "none" : "flex";
    const shell = document.getElementById("app-shell");
    shell.classList.toggle("is-question-shell", isQuestion);
}

function navigateTo(navKey) {
    stopSessionTimer();
    appState.activeNav = navKey;
    document.querySelectorAll("#main-nav .text-link").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.nav === navKey);
    });

    if (navKey === "home") {
        setView("view-home");
        renderHome();
    } else if (navKey === "history") {
        setView("view-history");
        renderHistory();
    } else if (navKey === "favorites") {
        setView("view-favorites");
        renderFavorites();
    } else if (navKey === "mistakes") {
        setView("view-mistakes");
        renderMistakes();
    } else if (navKey === "stats") {
        setView("view-stats");
        renderStats();
    }
}

/* ---------------- Auth & Setup Config UI ---------------- */

function parseRawConfigSnippet(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    try {
        const j = JSON.parse(trimmed);
        if (j && j.apiKey) return j;
    } catch (_) {}
    const extract = (key) => {
        const m = trimmed.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`));
        return m ? m[1].trim() : "";
    };
    const apiKey = extract("apiKey");
    const appId = extract("appId");
    if (!apiKey || !appId) return null;
    return {
        apiKey,
        authDomain: extract("authDomain") || "solvey-4cc26.firebaseapp.com",
        projectId: extract("projectId") || "solvey-4cc26",
        storageBucket: extract("storageBucket") || "solvey-4cc26.firebasestorage.app",
        messagingSenderId: extract("messagingSenderId"),
        appId
    };
}

function updateAuthUI() {
    const signInBtn = document.getElementById("topbar-signin-btn");
    const userLbl = document.getElementById("topbar-user-label");
    const signOutBtn = document.getElementById("topbar-signout-btn");
    const authPanel = document.getElementById("auth-prompt-panel");
    const setupPanel = document.getElementById("firebase-setup-panel");

    if (!cloud.bridge.ready) {
        setupPanel.style.display = "block";
        signInBtn.style.display = "none";
        userLbl.style.display = "none";
        signOutBtn.style.display = "none";
        authPanel.style.display = "none";
        return;
    }

    setupPanel.style.display = "none";
    if (cloud.bridge.user) {
        signInBtn.style.display = "none";
        userLbl.textContent = cloud.bridge.user.displayName || cloud.bridge.user.email || "Signed in";
        userLbl.style.display = "inline";
        signOutBtn.style.display = "inline";
        authPanel.style.display = "none";
    } else {
        signInBtn.style.display = "inline";
        userLbl.style.display = "none";
        signOutBtn.style.display = "none";
        const dismissed = sessionStorage.getItem("solvey_dismiss_auth") === "1";
        authPanel.style.display = dismissed ? "none" : "block";
    }
}

async function handleGoogleSignIn() {
    const statusEl = document.getElementById("auth-status");
    try {
        if (statusEl) {
            statusEl.className = "status-note";
            statusEl.textContent = "Opening Google sign-in...";
        }
        await cloud.signInGoogle();
        if (statusEl) statusEl.textContent = "";
    } catch (err) {
        if (statusEl) {
            statusEl.className = "status-note is-error";
            statusEl.textContent = (err && err.message) || "Sign-in was cancelled.";
        }
    }
}

/* ---------------- Data Helpers ---------------- */

async function preloadAllModules() {
    await Promise.all(
        YEAR5_MODULES.map(async (mod) => {
            await cloud.loadModuleTree(mod, appState.modulesCache, appState.cloudChecked);
        })
    );
    renderHome();
    populateFavoritesSubjectFilter();
}

function getModuleStats(mod) {
    const tree = appState.modulesCache[mod.key];
    if (!tree) return { total: 0, solved: 0, wrong: 0 };
    const qs = extractQuestions(tree);
    let solved = 0;
    let wrong = 0;
    for (const q of qs) {
        const qid = getQuestionId(q, mod.key);
        const st = appState.store.answered[qid];
        if (st === "correct") solved++;
        else if (st === "wrong") {
            solved++;
            wrong++;
        }
    }
    return { total: qs.length, solved, wrong };
}

function getQuestionCorrectIndex(q) {
    if (!q) return -1;
    if (typeof q.a === "number") return q.a;
    const opts = Array.isArray(q.o) ? q.o : [];
    const idx = opts.findIndex((o) => String(o).trim() === String(q.a).trim());
    return idx >= 0 ? idx : parseInt(q.a, 10);
}

/* ---------------- SCREEN 1: HOME ---------------- */

function renderUnfinishedStrip() {
    const strip = document.getElementById("unfinished-strip");
    const list = document.getElementById("unfinished-list");
    const pending = appState.store.pendingSessions || [];
    if (!pending.length) {
        strip.style.display = "none";
        list.innerHTML = "";
        return;
    }

    strip.style.display = "block";
    list.innerHTML = "";

    const p = pending[0];
    const card = document.createElement("div");
    card.className = "unfinished-card";

    const info = document.createElement("div");
    info.className = "unfinished-info";
    const title = document.createElement("span");
    title.className = "unfinished-title";
    title.textContent = `Continue: ${p.modTitle || p.modKey}`;

    const sub = document.createElement("span");
    sub.className = "unfinished-sub tabular";
    const answeredSoFar = (p.answers || []).filter((a) => a !== null).length;
    const modMeta = YEAR5_MODULES.find((m) => m.key === p.modKey);
    const catTxt = modMeta ? CATEGORY_LABELS[modMeta.category] : "";
    const modeTxt = p.settings && p.settings.mode === "exam" ? "Exam" : "Learning";
    sub.textContent = `${catTxt ? catTxt + " · " : ""}${modeTxt} · ${answeredSoFar} / ${(p.queue || []).length} answered`;

    info.appendChild(title);
    info.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "unfinished-actions";

    const disBtn = document.createElement("button");
    disBtn.type = "button";
    disBtn.className = "text-link";
    disBtn.textContent = "Discard";
    disBtn.addEventListener("click", () => {
        appState.store.pendingSessions = appState.store.pendingSessions.filter((x) => x.id !== p.id);
        cloud.scheduleSync(appState.store);
        renderUnfinishedStrip();
    });

    const resBtn = document.createElement("button");
    resBtn.type = "button";
    resBtn.className = "flat-btn is-primary";
    resBtn.textContent = "Resume";
    resBtn.addEventListener("click", () => resumePendingSession(p.id));

    actions.appendChild(disBtn);
    actions.appendChild(resBtn);

    card.appendChild(info);
    card.appendChild(actions);
    list.appendChild(card);
}

function renderHome() {
    renderUnfinishedStrip();

    const table = document.getElementById("subject-table");
    const statusEl = document.getElementById("home-status");
    if (!table) return;
    table.innerHTML = "";

    // Build dynamic type columns & grouped subject rows directly from YEAR5_MODULES
    const categories = [];
    const subjectOrder = [];
    const bySubject = new Map();

    for (const mod of YEAR5_MODULES) {
        if (!categories.includes(mod.category)) categories.push(mod.category);
        const sid = mod.subjectKey || mod.title;
        if (!bySubject.has(sid)) {
            bySubject.set(sid, { subjectId: sid, title: mod.title, byCat: {} });
            subjectOrder.push(sid);
        }
        bySubject.get(sid).byCat[mod.category] = mod;
    }

    table.style.setProperty("--type-cols", String(categories.length || 1));

    const term = appState.search.trim().toLowerCase();
    const visibleSubjects = subjectOrder
        .map((sid) => bySubject.get(sid))
        .filter((grp) => !term || grp.title.toLowerCase().includes(term));

    if (visibleSubjects.length === 0) {
        statusEl.textContent = "No matching subjects.";
        return;
    }
    statusEl.textContent = "";

    const headerRow = document.createElement("div");
    headerRow.className = "subjects-header-row";
    const hSubj = document.createElement("div");
    hSubj.textContent = "Subject";
    headerRow.appendChild(hSubj);
    categories.forEach((cat) => {
        const hCat = document.createElement("div");
        hCat.textContent = CATEGORY_LABELS[cat] || cat;
        headerRow.appendChild(hCat);
    });
    table.appendChild(headerRow);

    visibleSubjects.forEach((grp) => {
        const row = document.createElement("div");
        row.className = "subject-row-item";

        const nameCell = document.createElement("div");
        nameCell.className = "subject-name-cell";
        nameCell.textContent = grp.title;
        row.appendChild(nameCell);

        const cellsWrap = document.createElement("div");
        cellsWrap.className = "subject-type-cells-row";

        categories.forEach((cat) => {
            const mod = grp.byCat[cat];
            if (!mod) {
                const empty = document.createElement("div");
                empty.className = "type-cell-empty";
                empty.setAttribute("aria-label", `${grp.title} ${CATEGORY_LABELS[cat] || cat} unavailable`);
                empty.textContent = "—";
                cellsWrap.appendChild(empty);
                return;
            }

            const stats = getModuleStats(mod);
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "type-cell-btn";

            const mLbl = document.createElement("span");
            mLbl.className = "type-cell-mobile-label";
            mLbl.textContent = CATEGORY_LABELS[cat] || cat;
            btn.appendChild(mLbl);

            const nums = document.createElement("div");
            nums.className = "type-cell-nums tabular";
            const totalSpan = document.createElement("span");
            totalSpan.className = "type-cell-total";
            totalSpan.textContent = stats.total > 0 ? String(stats.total) : "—";
            nums.appendChild(totalSpan);

            if (stats.solved > 0) {
                const solvedSpan = document.createElement("span");
                solvedSpan.className = "type-cell-solved";
                solvedSpan.textContent = `${stats.solved} solved`;
                nums.appendChild(solvedSpan);
            }
            btn.appendChild(nums);

            const line = document.createElement("div");
            line.className = "progress-line";
            const fill = document.createElement("div");
            fill.className = "progress-line-fill";
            fill.style.width = stats.total > 0 ? `${Math.min(100, (stats.solved / stats.total) * 100)}%` : "0%";
            line.appendChild(fill);
            btn.appendChild(line);

            btn.addEventListener("click", () => openSessionSetup(mod));
            cellsWrap.appendChild(btn);
        });

        row.appendChild(cellsWrap);
        table.appendChild(row);
    });
}

/* ---------------- SCREEN 2: SESSION SETUP ---------------- */

async function openSessionSetup(mod, presetOverride = null) {
    await cloud.loadModuleTree(mod, appState.modulesCache, appState.cloudChecked);
    const tree = appState.modulesCache[mod.key] || {};
    const chapterKeys = Object.keys(tree).sort();

    const groups = [];
    const allSubIds = [];
    chapterKeys.forEach((ck) => {
        const val = tree[ck];
        const cleanChap = ck.replace(/^\d+\.\s*/, "");
        if (val && typeof val === "object" && !Array.isArray(val)) {
            const subKeys = Object.keys(val).sort();
            const items = subKeys.map((sk) => {
                const id = `${ck}___${sk}`;
                allSubIds.push(id);
                return {
                    id,
                    chapKey: ck,
                    subKey: sk,
                    label: sk.replace(/^\d+\.\s*/, ""),
                    chapterLabel: `${cleanChap} / ${sk.replace(/^\d+\.\s*/, "")}`,
                    node: val[sk]
                };
            });
            groups.push({ key: ck, label: cleanChap, items });
        } else {
            allSubIds.push(ck);
            groups.push({
                key: ck,
                label: cleanChap,
                items: [{
                    id: ck,
                    chapKey: ck,
                    subKey: null,
                    label: cleanChap,
                    chapterLabel: cleanChap,
                    node: val
                }]
            });
        }
    });

    const defaultSettings = presetOverride || {
        source: "unsolved",
        countType: "10",
        customCount: 15,
        order: "random",
        mode: "learning",
        timerType: "off",
        timerValue: 60,
        shuffleOptions: false
    };

    appState.setup = {
        mod,
        tree,
        groups,
        allSubIds,
        selectedLessons: new Set(allSubIds),
        expandedChapters: new Set(chapterKeys),
        search: "",
        settings: { ...defaultSettings }
    };

    document.getElementById("setup-subject-title").textContent = mod.title;
    document.getElementById("lesson-search-input").value = "";
    document.getElementById("preset-status").textContent = "";

    const switchEl = document.getElementById("setup-type-switch");
    if (switchEl) {
        switchEl.innerHTML = "";
        const siblingMods = YEAR5_MODULES.filter((m) => (m.subjectKey || m.title) === (mod.subjectKey || mod.title));
        siblingMods.forEach((sm) => {
            const sb = document.createElement("button");
            sb.type = "button";
            sb.className = `setup-type-btn${sm.key === mod.key ? " is-active" : ""}`;
            sb.textContent = CATEGORY_LABELS[sm.category] || sm.category;
            sb.addEventListener("click", () => {
                if (sm.key === mod.key) return;
                const preserved = appState.setup ? { ...appState.setup.settings } : null;
                openSessionSetup(sm, preserved);
            });
            switchEl.appendChild(sb);
        });
    }

    setView("view-setup");
    syncSetupControlsToUI();
    renderSetupPresets();
    renderSetupLessons();
}

function getNodeFilteredCount(mod, node, chapterLabel, source) {
    const qs = extractQuestions(node, chapterLabel);
    return qs.filter((q) => {
        const qid = getQuestionId(q, mod.key);
        const st = appState.store.answered[qid];
        if (source === "unsolved") return !st;
        if (source === "mistakes") return st === "wrong";
        if (source === "favorites") return Boolean(appState.store.bookmarked[qid]);
        return true;
    }).length;
}

function getSetupCandidateQuestions() {
    if (!appState.setup) return [];
    const { mod, groups, selectedLessons, settings } = appState.setup;
    const pool = [];
    for (const grp of groups) {
        for (const item of grp.items) {
            if (!selectedLessons.has(item.id)) continue;
            const qs = extractQuestions(item.node, item.chapterLabel);
            for (const q of qs) {
                const qid = getQuestionId(q, mod.key);
                const st = appState.store.answered[qid];
                if (settings.source === "unsolved" && st) continue;
                if (settings.source === "mistakes" && st !== "wrong") continue;
                if (settings.source === "favorites" && !appState.store.bookmarked[qid]) continue;
                pool.push({
                    ...q,
                    _qid: qid,
                    _moduleKey: mod.key
                });
            }
        }
    }
    return pool;
}

function syncSetupControlsToUI() {
    if (!appState.setup) return;
    const s = appState.setup.settings;

    const markGroup = (id, val) => {
        document.querySelectorAll(`#${id} .seg-btn`).forEach((b) => {
            b.classList.toggle("is-active", b.dataset.val === String(val));
        });
    };

    markGroup("setup-source-group", s.source);
    markGroup("setup-count-group", s.countType);
    markGroup("setup-order-group", s.order);
    markGroup("setup-mode-group", s.mode);
    markGroup("setup-timer-group", s.timerType);

    const customWrap = document.getElementById("setup-custom-count-wrap");
    customWrap.style.display = s.countType === "custom" ? "block" : "none";
    document.getElementById("setup-custom-count-input").value = s.customCount || 15;

    const timerWrap = document.getElementById("setup-timer-value-wrap");
    const timerLabel = document.getElementById("setup-timer-label");
    const timerInput = document.getElementById("setup-timer-input");
    if (s.timerType === "off") {
        timerWrap.style.display = "none";
    } else {
        timerWrap.style.display = "block";
        timerLabel.textContent = s.timerType === "per_question" ? "Seconds per question" : "Minutes for session";
        timerInput.value = s.timerValue;
    }

    document.getElementById("setup-shuffle-options").checked = Boolean(s.shuffleOptions);
    updateSetupOneLineSummary();
}

function renderSetupLessons() {
    const listEl = document.getElementById("lessons-list");
    if (!appState.setup || !listEl) return;
    listEl.innerHTML = "";

    const { mod, groups, allSubIds, selectedLessons, search, settings } = appState.setup;
    const term = search.trim().toLowerCase();

    groups.forEach((grp) => {
        const chapMatches = !term || grp.label.toLowerCase().includes(term);
        const matchingItems = chapMatches
            ? grp.items
            : grp.items.filter((it) => it.label.toLowerCase().includes(term));
        if (!matchingItems.length) return;

        const hasNestedSubtopics = grp.items.length > 1 || (grp.items[0] && grp.items[0].subKey !== null);
        const selectedInGroup = grp.items.filter((it) => selectedLessons.has(it.id)).length;
        const allInGroup = selectedInGroup === grp.items.length && grp.items.length > 0;
        const partialInGroup = selectedInGroup > 0 && selectedInGroup < grp.items.length;

        const groupCount = grp.items.reduce(
            (sum, it) => sum + getNodeFilteredCount(mod, it.node, it.chapterLabel, settings.source),
            0
        );

        const groupWrap = document.createElement("div");
        groupWrap.className = "lesson-group";

        const headerBtn = document.createElement("button");
        headerBtn.type = "button";
        headerBtn.className = "lesson-row-btn is-group";

        const left = document.createElement("div");
        left.className = "lesson-row-left";

        const checkBox = document.createElement("span");
        checkBox.className = `lesson-check${allInGroup ? " is-checked" : (partialInGroup ? " is-indeterminate" : "")}`;
        if (allInGroup) {
            checkBox.innerHTML = `<svg class="icon" style="width:12px;height:12px;" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>`;
        } else if (partialInGroup) {
            checkBox.innerHTML = `<svg class="icon" style="width:12px;height:12px;" viewBox="0 0 24 24"><path d="M5 12h14"></path></svg>`;
        }

        const label = document.createElement("span");
        label.textContent = grp.label;

        left.appendChild(checkBox);
        left.appendChild(label);

        const countSpan = document.createElement("span");
        countSpan.className = "lesson-count tabular";
        countSpan.textContent = `${groupCount}`;

        headerBtn.appendChild(left);
        headerBtn.appendChild(countSpan);

        headerBtn.addEventListener("click", () => {
            if (allInGroup) {
                grp.items.forEach((it) => selectedLessons.delete(it.id));
            } else {
                grp.items.forEach((it) => selectedLessons.add(it.id));
            }
            renderSetupLessons();
        });

        groupWrap.appendChild(headerBtn);

        if (hasNestedSubtopics) {
            matchingItems.forEach((item) => {
                const isSel = selectedLessons.has(item.id);
                const itemCount = getNodeFilteredCount(mod, item.node, item.chapterLabel, settings.source);

                const subBtn = document.createElement("button");
                subBtn.type = "button";
                subBtn.className = "lesson-row-btn is-child";

                const sLeft = document.createElement("div");
                sLeft.className = "lesson-row-left";

                const sCheck = document.createElement("span");
                sCheck.className = `lesson-check${isSel ? " is-checked" : ""}`;
                if (isSel) {
                    sCheck.innerHTML = `<svg class="icon" style="width:12px;height:12px;" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>`;
                }

                const sLbl = document.createElement("span");
                sLbl.textContent = item.label;

                sLeft.appendChild(sCheck);
                sLeft.appendChild(sLbl);

                const sCnt = document.createElement("span");
                sCnt.className = "lesson-count tabular";
                sCnt.textContent = `${itemCount}`;

                subBtn.appendChild(sLeft);
                subBtn.appendChild(sCnt);

                subBtn.addEventListener("click", () => {
                    if (selectedLessons.has(item.id)) selectedLessons.delete(item.id);
                    else selectedLessons.add(item.id);
                    renderSetupLessons();
                });

                groupWrap.appendChild(subBtn);
            });
        }

        listEl.appendChild(groupWrap);
    });

    const allBtn = document.getElementById("lessons-select-all-btn");
    const allSel = allSubIds.length > 0 && selectedLessons.size === allSubIds.length;
    allBtn.textContent = allSel ? "Clear all" : "Select all";
    document.getElementById("lessons-selected-count").textContent = `${selectedLessons.size} of ${allSubIds.length} selected`;
    updateSetupOneLineSummary();
}

function updateSetupOneLineSummary() {
    if (!appState.setup) return;
    const pool = getSetupCandidateQuestions();
    const s = appState.setup.settings;

    const customInp = document.getElementById("setup-custom-count-input");
    const maxLbl = document.getElementById("setup-custom-max-label");
    if (customInp) customInp.max = String(Math.max(1, pool.length));
    if (maxLbl) maxLbl.textContent = `questions (max ${pool.length})`;

    const requested = s.countType === "all"
        ? pool.length
        : (s.countType === "custom" ? Math.max(1, parseInt(s.customCount, 10) || 10) : parseInt(s.countType, 10));
    const finalCount = Math.min(pool.length, requested);

    const srcMap = { unsolved: "Unsolved", mistakes: "Mistakes", favorites: "Favorites", all: "All" };
    const ordMap = { random: "Random", sequential: "Sequential", hardest: "Hardest first" };
    const modMap = { learning: "Learning", exam: "Exam" };
    const timerTxt = s.timerType === "off"
        ? "No timer"
        : (s.timerType === "per_question" ? `${s.timerValue}s / question` : `${s.timerValue}m session`);

    const summaryEl = document.getElementById("setup-oneline-summary");
    const startBtn = document.getElementById("start-session-btn");

    if (finalCount === 0) {
        summaryEl.textContent = "No matching questions in selected lessons.";
        startBtn.disabled = true;
    } else {
        summaryEl.textContent = `${finalCount} questions · ${srcMap[s.source]} · ${ordMap[s.order]} · ${modMap[s.mode]} · ${timerTxt}`;
        startBtn.disabled = false;
    }
}

function renderSetupPresets() {
    const wrap = document.getElementById("presets-container");
    const list = document.getElementById("presets-list");
    const presets = appState.store.presets || [];
    if (!presets.length) {
        wrap.style.display = "none";
        list.innerHTML = "";
        return;
    }
    wrap.style.display = "block";
    list.innerHTML = "";
    presets.forEach((pr) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "seg-btn";
        btn.textContent = pr.name;
        btn.addEventListener("click", () => {
            if (!appState.setup) return;
            appState.setup.settings = { ...pr.settings };
            syncSetupControlsToUI();
            renderSetupLessons();
        });
        list.appendChild(btn);
    });
}

function saveCurrentPreset() {
    if (!appState.setup) return;
    const s = appState.setup.settings;
    const countPart = s.countType === "all" ? "All" : (s.countType === "custom" ? s.customCount : s.countType);
    const modePart = s.mode === "exam" ? "Exam" : "Learn";
    const name = `${countPart} · ${modePart} · ${s.source}`;

    const presets = appState.store.presets || [];
    const filtered = presets.filter((p) => p.name !== name);
    filtered.unshift({
        id: `preset_${Date.now()}`,
        name,
        settings: { ...s }
    });
    appState.store.presets = filtered.slice(0, 6);
    cloud.scheduleSync(appState.store);
    renderSetupPresets();
    document.getElementById("preset-status").textContent = "Preset saved";
}

function prepareQuestionForSession(q, shuffleOptions) {
    const origOpts = Array.isArray(q.o) ? q.o.slice() : [];
    const origCorrect = getQuestionCorrectIndex(q);

    let mapped = origOpts.map((text, idx) => ({ text, isKey: idx === origCorrect }));
    if (shuffleOptions && mapped.length > 1) {
        for (let i = mapped.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = mapped[i];
            mapped[i] = mapped[j];
            mapped[j] = tmp;
        }
    }

    const correctIndex = mapped.findIndex((m) => m.isKey);
    return {
        _qid: q._qid,
        _moduleKey: q._moduleKey,
        _chapter: q._chapter || "",
        q: q.q || "",
        o: mapped.map((m) => m.text),
        correctIndex,
        explanation: q.explanation || q.exp || q.e || "",
        img: q.img || ""
    };
}

function orderQuestions(pool, order) {
    const copy = pool.slice();
    if (order === "random") {
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = copy[i];
            copy[i] = copy[j];
            copy[j] = t;
        }
        return copy;
    }
    if (order === "hardest") {
        return copy.sort((a, b) => {
            const wa = appState.store.wrongCounts[a._qid] || 0;
            const wb = appState.store.wrongCounts[b._qid] || 0;
            const aa = appState.store.attemptCounts[a._qid] || 0;
            const ab = appState.store.attemptCounts[b._qid] || 0;
            const ra = aa > 0 ? wa / aa : (appState.store.answered[a._qid] === "wrong" ? 1 : 0.25);
            const rb = ab > 0 ? wb / ab : (appState.store.answered[b._qid] === "wrong" ? 1 : 0.25);
            if (rb !== ra) return rb - ra;
            return wb - wa;
        });
    }
    return copy; // sequential
}

function startConfiguredSession(customQueue = null) {
    if (!appState.setup) return;
    const { mod, settings } = appState.setup;

    let queue;
    if (customQueue) {
        queue = customQueue;
    } else {
        const pool = orderQuestions(getSetupCandidateQuestions(), settings.order);
        const requested = settings.countType === "all"
            ? pool.length
            : (settings.countType === "custom" ? Math.max(1, parseInt(settings.customCount, 10) || 10) : parseInt(settings.countType, 10));
        queue = pool.slice(0, requested).map((q) => prepareQuestionForSession(q, settings.shuffleOptions));
    }

    if (!queue.length) return;

    appState.session = {
        id: `sess_${Date.now()}`,
        modKey: mod.key,
        modTitle: mod.title,
        settings: { ...settings },
        queue,
        answers: new Array(queue.length).fill(null),
        struck: queue.map(() => []),
        index: 0,
        elapsedSec: 0,
        qTimeLeft: settings.timerType === "per_question" ? (parseInt(settings.timerValue, 10) || 60) : 0,
        sessionTimeLeft: settings.timerType === "session" ? ((parseInt(settings.timerValue, 10) || 20) * 60) : 0,
        strikeMode: false
    };

    openQuestionScreen();
}

function resumePendingSession(pendingId) {
    const p = (appState.store.pendingSessions || []).find((x) => x.id === pendingId);
    if (!p) return;
    appState.store.pendingSessions = appState.store.pendingSessions.filter((x) => x.id !== pendingId);
    cloud.scheduleSync(appState.store);

    appState.session = {
        ...p,
        strikeMode: false
    };
    openQuestionScreen();
}

/* ---------------- SCREEN 3: QUESTION ---------------- */

function stopSessionTimer() {
    if (appState.timerInterval) {
        clearInterval(appState.timerInterval);
        appState.timerInterval = null;
    }
}

function startSessionTimer() {
    stopSessionTimer();
    const display = document.getElementById("q-timer-display");
    const sess = appState.session;
    if (!sess) return;

    const type = sess.settings.timerType;
    if (type === "off") {
        display.style.display = "none";
    } else {
        display.style.display = "inline";
        display.textContent = formatDuration(type === "per_question" ? sess.qTimeLeft : sess.sessionTimeLeft);
    }

    appState.timerInterval = setInterval(() => {
        if (!appState.session) return;
        appState.session.elapsedSec++;

        if (appState.session.settings.timerType === "per_question") {
            appState.session.qTimeLeft--;
            display.textContent = formatDuration(appState.session.qTimeLeft);
            if (appState.session.qTimeLeft <= 0) {
                if (appState.session.index + 1 < appState.session.queue.length) {
                    jumpToQuestion(appState.session.index + 1);
                } else {
                    finishActiveSession();
                }
            }
        } else if (appState.session.settings.timerType === "session") {
            appState.session.sessionTimeLeft--;
            display.textContent = formatDuration(appState.session.sessionTimeLeft);
            if (appState.session.sessionTimeLeft <= 0) {
                finishActiveSession();
            }
        }
    }, 1000);
}

function openQuestionScreen() {
    setView("view-question");
    document.getElementById("qmap-drawer").classList.remove("is-open");
    renderCurrentQuestion();
    startSessionTimer();
}

function renderQuestionMap() {
    const grid = document.getElementById("qmap-grid");
    const sess = appState.session;
    if (!grid || !sess) return;
    grid.innerHTML = "";

    sess.queue.forEach((q, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "qmap-btn tabular";
        btn.dataset.qidx = String(idx);
        btn.textContent = String(idx + 1);

        const ans = sess.answers[idx];
        if (idx === sess.index) btn.classList.add("is-current");
        if (ans !== null) {
            if (sess.settings.mode === "learning") {
                btn.classList.add(ans === q.correctIndex ? "is-correct" : "is-wrong");
            } else {
                btn.classList.add("is-answered");
            }
        }
        if (appState.store.bookmarked[q._qid]) {
            btn.classList.add("is-flagged");
        }

        btn.addEventListener("click", () => {
            jumpToQuestion(idx);
        });
        grid.appendChild(btn);
    });
}

function renderCurrentQuestion() {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const chosen = sess.answers[sess.index];
    const isLearning = sess.settings.mode === "learning";
    const revealed = isLearning && chosen !== null;

    document.getElementById("q-subject-label").textContent = sess.modTitle;
    document.getElementById("q-counter").textContent = `${sess.index + 1} / ${sess.queue.length}`;
    const qProg = document.getElementById("q-progress-fill");
    if (qProg) qProg.style.width = `${((sess.index + 1) / sess.queue.length) * 100}%`;
    document.getElementById("q-lesson-label").textContent = q._chapter || "";
    document.getElementById("q-mode-badge").textContent = isLearning ? "Learning" : "Exam";

    const stemEl = document.getElementById("q-stem");
    stemEl.textContent = q.q;
    stemEl.setAttribute("dir", hasArabic(q.q) ? "rtl" : "ltr");

    const mediaWrap = document.getElementById("q-media");
    const imgEl = document.getElementById("q-img");
    const imgSrc = resolveMediaPath(q.img);
    if (imgSrc) {
        imgEl.src = imgSrc;
        mediaWrap.style.display = "block";
    } else {
        imgEl.removeAttribute("src");
        mediaWrap.style.display = "none";
    }

    const optsList = document.getElementById("q-options-list");
    optsList.innerHTML = "";
    const struckArr = sess.struck[sess.index] || [];

    q.o.forEach((optText, idx) => {
        const li = document.createElement("li");
        li.className = `option-row${struckArr.includes(idx) ? " is-struck" : ""}`;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "option-btn";
        btn.dataset.index = String(idx);
        btn.setAttribute("dir", hasArabic(optText) ? "rtl" : "ltr");

        if (revealed) {
            btn.disabled = true;
            if (idx === q.correctIndex) btn.classList.add("is-correct");
            else if (idx === chosen) btn.classList.add("is-wrong");
        } else if (!isLearning && chosen === idx) {
            btn.classList.add("is-selected");
        }

        const letter = document.createElement("span");
        letter.className = "option-letter";
        letter.textContent = OPTION_LETTERS[idx] || String(idx + 1);

        const textSpan = document.createElement("span");
        textSpan.className = "option-text";
        textSpan.textContent = optText;

        const feedbackWrap = document.createElement("span");
        feedbackWrap.className = "option-feedback";
        feedbackWrap.setAttribute("aria-hidden", "true");
        if (revealed) {
            if (idx === q.correctIndex) {
                feedbackWrap.innerHTML = `<svg class="q-icon" viewBox="0 0 24 24"><path class="opt-check-path" d="M5 13l4 4L19 7"></path></svg><span class="option-feedback-label">Correct</span>`;
            } else if (idx === chosen) {
                feedbackWrap.innerHTML = `<svg class="q-icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"></path></svg><span class="option-feedback-label">Wrong</span>`;
            }
        }

        btn.appendChild(letter);
        btn.appendChild(textSpan);
        btn.appendChild(feedbackWrap);
        btn.addEventListener("click", () => {
            handleOptionSelect(idx);
        });

        const strikeBtn = document.createElement("button");
        strikeBtn.type = "button";
        strikeBtn.className = "option-strike-btn";
        strikeBtn.title = "Strike out option";
        strikeBtn.setAttribute("aria-label", `Strike out option ${OPTION_LETTERS[idx] || idx + 1}`);
        strikeBtn.innerHTML = `<svg class="q-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h14M7 12h10M9 15h6"></path></svg>`;
        strikeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleStrikeOption(idx);
        });

        li.appendChild(btn);
        li.appendChild(strikeBtn);
        optsList.appendChild(li);
    });

    // Tools state
    const isFav = Boolean(appState.store.bookmarked[q._qid]);
    document.getElementById("tool-fav-btn").classList.toggle("is-flagged", isFav);
    document.getElementById("tool-fav-label").textContent = isFav ? "Favorited" : "Favorite";

    const hasNote = Boolean(appState.store.notes[q._qid] && appState.store.notes[q._qid].text);
    document.getElementById("tool-note-btn").classList.toggle("is-accent", hasNote);
    document.getElementById("tool-note-label").textContent = hasNote ? "Note saved" : "Note";

    // Drawers closed on question render
    document.getElementById("note-drawer").classList.remove("is-open");
    document.getElementById("report-drawer").classList.remove("is-open");

    // Clear previous live announcement on question render
    const liveEl = document.getElementById("q-answer-live");
    if (liveEl) liveEl.textContent = "";

    // Explanation in learning mode once answered (trimmed so empty/whitespace shows no box)
    const expBlock = document.getElementById("q-explanation-block");
    const expText = document.getElementById("q-explanation-text");
    const cleanExp = (q.explanation || "").trim();
    if (revealed && cleanExp) {
        expText.textContent = cleanExp;
        expText.setAttribute("dir", hasArabic(cleanExp) ? "rtl" : "ltr");
        expBlock.classList.add("is-visible");
    } else {
        expText.textContent = "";
        expBlock.classList.remove("is-visible");
    }

    document.getElementById("q-prev-btn").style.visibility = sess.index === 0 ? "hidden" : "visible";
    document.getElementById("q-next-label").textContent = sess.index + 1 >= sess.queue.length ? "Finish" : "Next";

    renderQuestionMap();
}

function updateToolsInPlace() {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const isFav = Boolean(appState.store.bookmarked[q._qid]);
    document.getElementById("tool-fav-btn").classList.toggle("is-flagged", isFav);
    document.getElementById("tool-fav-label").textContent = isFav ? "Favorited" : "Favorite";

    const hasNote = Boolean(appState.store.notes[q._qid] && appState.store.notes[q._qid].text);
    document.getElementById("tool-note-btn").classList.toggle("is-accent", hasNote);
    document.getElementById("tool-note-label").textContent = hasNote ? "Note saved" : "Note";
}

function updateMapButtonInPlace(idx) {
    const sess = appState.session;
    if (!sess) return;
    const btn = document.querySelector(`#qmap-grid .qmap-btn[data-qidx="${idx}"]`);
    if (!btn) return;
    const q = sess.queue[idx];
    const ans = sess.answers[idx];
    btn.className = "qmap-btn tabular";
    if (idx === sess.index) btn.classList.add("is-current");
    if (ans !== null) {
        if (sess.settings.mode === "learning") {
            btn.classList.add(ans === q.correctIndex ? "is-correct" : "is-wrong");
        } else {
            btn.classList.add("is-answered");
        }
    }
    if (appState.store.bookmarked[q._qid]) btn.classList.add("is-flagged");
}

function updateOptionStatesInPlace(animateNew = false) {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const chosen = sess.answers[sess.index];
    const isLearning = sess.settings.mode === "learning";
    const revealed = isLearning && chosen !== null;

    document.querySelectorAll("#q-options-list .option-btn").forEach((btn) => {
        const idx = parseInt(btn.dataset.index, 10);
        btn.classList.remove("is-selected", "is-correct", "is-wrong", "is-just-answered", "is-just-wrong");
        btn.disabled = revealed;
        const fb = btn.querySelector(".option-feedback");
        if (fb) fb.innerHTML = "";
        if (revealed) {
            if (idx === q.correctIndex) {
                btn.classList.add("is-correct");
                if (animateNew) btn.classList.add("is-just-answered");
                if (fb) fb.innerHTML = `<svg class="q-icon" viewBox="0 0 24 24"><path class="opt-check-path" d="M5 13l4 4L19 7"></path></svg><span class="option-feedback-label">Correct</span>`;
            } else if (idx === chosen) {
                btn.classList.add("is-wrong");
                if (animateNew) {
                    void btn.offsetWidth;
                    btn.classList.add("is-just-wrong");
                }
                if (fb) fb.innerHTML = `<svg class="q-icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"></path></svg><span class="option-feedback-label">Wrong</span>`;
            }
        } else if (!isLearning && chosen === idx) {
            btn.classList.add("is-selected");
        }
    });

    if (animateNew && revealed) {
        const liveEl = document.getElementById("q-answer-live");
        if (liveEl) {
            if (chosen === q.correctIndex) {
                liveEl.textContent = "Correct";
            } else {
                const keyLetter = OPTION_LETTERS[q.correctIndex] || String(q.correctIndex + 1);
                liveEl.textContent = `Wrong. Correct answer is ${keyLetter}`;
            }
        }
    }

    const expBlock = document.getElementById("q-explanation-block");
    const expText = document.getElementById("q-explanation-text");
    const cleanExp = (q.explanation || "").trim();
    if (revealed && cleanExp) {
        expText.textContent = cleanExp;
        expText.setAttribute("dir", hasArabic(cleanExp) ? "rtl" : "ltr");
        expBlock.classList.add("is-visible");
    } else {
        expText.textContent = "";
        expBlock.classList.remove("is-visible");
    }
    updateMapButtonInPlace(sess.index);
}

function toggleStrikeOption(optIdx) {
    const sess = appState.session;
    if (!sess) return;
    const arr = sess.struck[sess.index] || [];
    const pos = arr.indexOf(optIdx);
    if (pos >= 0) arr.splice(pos, 1);
    else arr.push(optIdx);
    sess.struck[sess.index] = arr;
    const rows = document.querySelectorAll("#q-options-list .option-row");
    if (rows[optIdx]) rows[optIdx].classList.toggle("is-struck", pos < 0);
}

function handleOptionSelect(optIdx) {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const isLearning = sess.settings.mode === "learning";

    if (isLearning && sess.answers[sess.index] !== null) return;

    const wasUnanswered = sess.answers[sess.index] === null;
    sess.answers[sess.index] = optIdx;

    if (isLearning && wasUnanswered) {
        const isCorrect = optIdx === q.correctIndex;
        appState.store.answered[q._qid] = isCorrect ? "correct" : "wrong";
        appState.store.attemptCounts[q._qid] = (appState.store.attemptCounts[q._qid] || 0) + 1;
        if (!isCorrect) {
            appState.store.wrongCounts[q._qid] = (appState.store.wrongCounts[q._qid] || 0) + 1;
        }
        cloud.scheduleSync(appState.store);
    }

    updateOptionStatesInPlace(isLearning && wasUnanswered);
}

function jumpToQuestion(targetIndex) {
    const sess = appState.session;
    if (!sess || targetIndex < 0 || targetIndex >= sess.queue.length) return;
    sess.index = targetIndex;
    if (sess.settings.timerType === "per_question") {
        sess.qTimeLeft = parseInt(sess.settings.timerValue, 10) || 60;
    }
    renderCurrentQuestion();
    window.scrollTo({ top: 0, behavior: "auto" });

    const fadeEl = document.getElementById("question-fade");
    if (fadeEl) {
        fadeEl.classList.remove("is-entering");
        void fadeEl.offsetWidth;
        fadeEl.classList.add("is-entering");
    }
}

function pauseActiveSession() {
    const sess = appState.session;
    if (!sess) return;
    stopSessionTimer();

    const snapshot = {
        ...sess,
        savedAt: Date.now()
    };
    delete snapshot.strikeMode;

    const existing = appState.store.pendingSessions || [];
    appState.store.pendingSessions = [snapshot, ...existing.filter((x) => x.id !== sess.id)].slice(0, 8);
    cloud.scheduleSync(appState.store);
    appState.session = null;
    navigateTo("home");
}

function finishActiveSession() {
    const sess = appState.session;
    if (!sess) return;
    stopSessionTimer();

    let correct = 0;
    let wrong = 0;
    let skipped = 0;

    sess.queue.forEach((q, idx) => {
        const ans = sess.answers[idx];
        if (ans === null) {
            skipped++;
            return;
        }
        const isCorrect = ans === q.correctIndex;
        if (isCorrect) correct++;
        else wrong++;

        // Commit exam mode answers upon finish
        if (sess.settings.mode === "exam") {
            appState.store.answered[q._qid] = isCorrect ? "correct" : "wrong";
            appState.store.attemptCounts[q._qid] = (appState.store.attemptCounts[q._qid] || 0) + 1;
            if (!isCorrect) {
                appState.store.wrongCounts[q._qid] = (appState.store.wrongCounts[q._qid] || 0) + 1;
            }
        }
    });

    const resultRecord = {
        id: sess.id,
        modKey: sess.modKey,
        modTitle: sess.modTitle,
        settings: { ...sess.settings },
        queue: sess.queue,
        answers: sess.answers,
        correct,
        wrong,
        skipped,
        durationSec: sess.elapsedSec || 0,
        finishedAt: Date.now()
    };

    appState.store.totalSeconds = (appState.store.totalSeconds || 0) + (sess.elapsedSec || 0);
    appState.store.history = [resultRecord, ...(appState.store.history || [])].slice(0, 40);
    appState.store.pendingSessions = (appState.store.pendingSessions || []).filter((x) => x.id !== sess.id);
    cloud.scheduleSync(appState.store);

    appState.session = null;
    openResultsScreen(resultRecord);
}

/* ---------------- SCREEN 4: RESULTS + REVIEW ---------------- */

function openResultsScreen(record) {
    appState.results = record;
    appState.resultsFilter = "all";
    setView("view-results");

    document.getElementById("res-title").textContent = record.modTitle;
    const total = record.queue.length;
    const answered = record.correct + record.wrong;
    const acc = answered > 0 ? Math.round((record.correct / answered) * 100) : 0;
    document.getElementById("res-subtitle").textContent =
        `${record.settings.mode === "exam" ? "Exam mode" : "Learning mode"} · ${total} questions · ${formatDuration(record.durationSec)}`;

    const statsRow = document.getElementById("res-stats-row");
    statsRow.innerHTML = `
        <div class="stat-card"><div class="stat-label">Answered</div><div class="stat-value">${answered} / ${total}</div></div>
        <div class="stat-card"><div class="stat-label">Correct</div><div class="stat-value fig-correct">${record.correct}</div></div>
        <div class="stat-card"><div class="stat-label">Incorrect</div><div class="stat-value fig-wrong">${record.wrong}</div></div>
        <div class="stat-card"><div class="stat-label">Skipped</div><div class="stat-value">${record.skipped}</div></div>
        <div class="stat-card"><div class="stat-label">Accuracy</div><div class="stat-value">${acc}%</div></div>
    `;

    const retryBtn = document.getElementById("res-retry-mistakes-btn");
    retryBtn.style.display = record.wrong > 0 ? "inline-flex" : "none";

    document.querySelectorAll("#res-filter-tabs .filter-chip").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.rfilter === "all");
    });
    renderResultsReviewList();
}

function renderResultsReviewList() {
    const listEl = document.getElementById("res-review-list");
    const rec = appState.results;
    if (!listEl || !rec) return;
    listEl.innerHTML = "";

    const filter = appState.resultsFilter;

    rec.queue.forEach((q, idx) => {
        const ans = rec.answers[idx];
        const status = ans === null ? "skipped" : (ans === q.correctIndex ? "correct" : "wrong");
        if (filter !== "all" && status !== filter) return;

        const card = document.createElement("div");
        card.className = `review-card ${status === "correct" ? "is-correct" : (status === "wrong" ? "is-wrong" : "")}`;

        const meta = document.createElement("div");
        meta.className = "question-meta-row";
        meta.style.marginBottom = "8px";
        meta.innerHTML = `<span class="tabular">Question ${idx + 1}</span><span>${status === "correct" ? "Correct" : (status === "wrong" ? "Incorrect" : "Skipped")}</span>`;

        const stem = document.createElement("div");
        stem.style.fontWeight = "600";
        stem.style.fontSize = "1.08rem";
        stem.style.lineHeight = "1.6";
        stem.style.marginBottom = "10px";
        stem.setAttribute("dir", hasArabic(q.q) ? "rtl" : "ltr");
        stem.textContent = q.q;

        const ansLines = document.createElement("div");
        ansLines.style.fontSize = "0.9rem";
        ansLines.style.color = "var(--muted)";
        const yourTxt = ans !== null ? `${OPTION_LETTERS[ans]}. ${q.o[ans] || ""}` : "None";
        const keyTxt = `${OPTION_LETTERS[q.correctIndex]}. ${q.o[q.correctIndex] || ""}`;
        ansLines.innerHTML = `<div>Your answer: <span style="color: var(--text);">${escapeHtml(yourTxt)}</span></div><div>Key: <span class="fig-correct">${escapeHtml(keyTxt)}</span></div>`;

        card.appendChild(meta);
        card.appendChild(stem);
        card.appendChild(ansLines);

        const cleanRevExp = (q.explanation || "").trim();
        if (cleanRevExp) {
            const exp = document.createElement("div");
            exp.className = "review-explanation";
            exp.setAttribute("dir", hasArabic(cleanRevExp) ? "rtl" : "ltr");
            exp.textContent = cleanRevExp;
            card.appendChild(exp);
        }

        const savedNote = appState.store.notes[q._qid];
        if (savedNote && savedNote.text) {
            const noteDiv = document.createElement("div");
            noteDiv.style.marginTop = "8px";
            noteDiv.style.fontSize = "0.86rem";
            noteDiv.style.color = "var(--accent)";
            noteDiv.textContent = `Note: ${savedNote.text}`;
            card.appendChild(noteDiv);
        }

        listEl.appendChild(card);
    });
}

/* ---------------- SCREEN 5: HISTORY, FAVORITES, MISTAKES, STATS ---------------- */

function renderHistory() {
    const listEl = document.getElementById("history-list");
    const emptyEl = document.getElementById("history-empty");
    const hist = appState.store.history || [];
    listEl.innerHTML = "";

    if (!hist.length) {
        emptyEl.textContent = "No completed sessions yet.";
        return;
    }
    emptyEl.textContent = "";

    hist.forEach((h) => {
        const row = document.createElement("div");
        row.className = "desk-row-card";

        const left = document.createElement("div");
        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.textContent = h.modTitle || h.modKey;
        const meta = document.createElement("div");
        meta.className = "status-note tabular";
        meta.style.marginTop = "2px";
        const dStr = new Date(h.finishedAt).toLocaleDateString();
        meta.textContent = `${dStr} · ${h.settings.mode === "exam" ? "Exam" : "Learning"} · ${h.correct} correct, ${h.wrong} wrong, ${h.skipped} skipped · ${formatDuration(h.durationSec)}`;
        left.appendChild(title);
        left.appendChild(meta);

        const right = document.createElement("button");
        right.type = "button";
        right.className = "text-link is-accent";
        right.textContent = "Review";
        right.addEventListener("click", () => openResultsScreen(h));

        row.appendChild(left);
        row.appendChild(right);
        listEl.appendChild(row);
    });
}

function populateFavoritesSubjectFilter() {
    const sel = document.getElementById("fav-subject-filter");
    if (!sel) return;
    const current = sel.value || "all";
    sel.innerHTML = `<option value="all">All subjects</option>`;
    YEAR5_MODULES.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.key;
        opt.textContent = `${m.title} (${CATEGORY_LABELS[m.category]})`;
        sel.appendChild(opt);
    });
    sel.value = current;
}

function getAllSavedQuestionEntries() {
    const map = new Map();
    const bms = appState.store.bookmarked || {};
    const notes = appState.store.notes || {};

    for (const [qid, val] of Object.entries(bms)) {
        if (!val) continue;
        map.set(qid, {
            qid,
            fav: true,
            note: notes[qid] ? notes[qid].text : "",
            snapshot: typeof val === "object" ? val : null
        });
    }
    for (const [qid, nVal] of Object.entries(notes)) {
        if (!nVal || !nVal.text) continue;
        const existing = map.get(qid) || { qid, fav: false, note: nVal.text, snapshot: nVal };
        existing.note = nVal.text;
        if (!existing.snapshot) existing.snapshot = nVal;
        map.set(qid, existing);
    }
    return Array.from(map.values());
}

function findQuestionByIdFallback(qid, modKeyHint) {
    const searchMods = modKeyHint
        ? YEAR5_MODULES.filter((m) => m.key === modKeyHint)
        : YEAR5_MODULES;
    for (const m of searchMods) {
        const tree = appState.modulesCache[m.key];
        if (!tree) continue;
        const all = extractQuestions(tree);
        for (const q of all) {
            if (getQuestionId(q, m.key) === qid) {
                return { ...q, _qid: qid, _moduleKey: m.key };
            }
        }
    }
    return null;
}

function renderFavorites() {
    const listEl = document.getElementById("favorites-list");
    const emptyEl = document.getElementById("favorites-empty");
    const term = (document.getElementById("fav-search-input").value || "").trim().toLowerCase();
    const subj = document.getElementById("fav-subject-filter").value || "all";

    listEl.innerHTML = "";
    const entries = getAllSavedQuestionEntries().filter((entry) => {
        const snap = entry.snapshot || findQuestionByIdFallback(entry.qid);
        if (!snap) return false;
        entry.resolved = snap;
        const modKey = snap.moduleKey || snap._moduleKey || "";
        if (subj !== "all" && modKey !== subj) return false;
        if (term) {
            const hay = `${snap.q || ""} ${entry.note || ""}`.toLowerCase();
            if (!hay.includes(term)) return false;
        }
        return true;
    });

    if (!entries.length) {
        emptyEl.textContent = "No favorited questions or notes found.";
        return;
    }
    emptyEl.textContent = "";

    entries.forEach((entry) => {
        const q = entry.resolved;
        const card = document.createElement("div");
        card.className = "review-card";

        const head = document.createElement("div");
        head.className = "question-meta-row";
        head.innerHTML = `<span>${escapeHtml(q.moduleKey || q._moduleKey || "")}</span><span>${entry.fav ? "Favorited" : "Note"}</span>`;

        const stem = document.createElement("div");
        stem.style.fontWeight = "600";
        stem.style.fontSize = "1.06rem";
        stem.style.marginBottom = "10px";
        stem.setAttribute("dir", hasArabic(q.q) ? "rtl" : "ltr");
        stem.textContent = q.q || "";

        card.appendChild(head);
        card.appendChild(stem);

        if (entry.note) {
            const noteP = document.createElement("div");
            noteP.style.fontSize = "0.9rem";
            noteP.style.color = "var(--accent)";
            noteP.style.marginBottom = "10px";
            noteP.textContent = `Note: ${entry.note}`;
            card.appendChild(noteP);
        }

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "16px";
        if (entry.fav) {
            const rmFav = document.createElement("button");
            rmFav.type = "button";
            rmFav.className = "text-link";
            rmFav.textContent = "Remove favorite";
            rmFav.addEventListener("click", () => {
                delete appState.store.bookmarked[entry.qid];
                cloud.scheduleSync(appState.store);
                renderFavorites();
            });
            actions.appendChild(rmFav);
        }
        if (entry.note) {
            const rmNote = document.createElement("button");
            rmNote.type = "button";
            rmNote.className = "text-link";
            rmNote.textContent = "Delete note";
            rmNote.addEventListener("click", () => {
                delete appState.store.notes[entry.qid];
                cloud.scheduleSync(appState.store);
                renderFavorites();
            });
            actions.appendChild(rmNote);
        }
        card.appendChild(actions);
        listEl.appendChild(card);
    });
}

function renderMistakes() {
    const listEl = document.getElementById("mistakes-list");
    const emptyEl = document.getElementById("mistakes-empty");
    listEl.innerHTML = "";

    let any = false;
    YEAR5_MODULES.forEach((mod) => {
        const stats = getModuleStats(mod);
        if (stats.wrong === 0) return;
        any = true;

        const row = document.createElement("div");
        row.className = "desk-row-card";

        const left = document.createElement("div");
        const title = document.createElement("div");
        title.style.fontWeight = "600";
        title.textContent = `${mod.title} · ${CATEGORY_LABELS[mod.category]}`;
        const sub = document.createElement("div");
        sub.className = "status-note tabular fig-wrong";
        sub.style.marginTop = "2px";
        sub.textContent = `${stats.wrong} wrong answers`;
        left.appendChild(title);
        left.appendChild(sub);

        const practiceBtn = document.createElement("button");
        practiceBtn.type = "button";
        practiceBtn.className = "flat-btn";
        practiceBtn.textContent = "Review mistakes";
        practiceBtn.addEventListener("click", () => {
            openSessionSetup(mod, {
                source: "mistakes",
                countType: "all",
                customCount: 20,
                order: "hardest",
                mode: "learning",
                timerType: "off",
                timerValue: 60,
                shuffleOptions: false
            });
        });

        row.appendChild(left);
        row.appendChild(practiceBtn);
        listEl.appendChild(row);
    });

    emptyEl.textContent = any ? "" : "No mistakes recorded across subjects.";
}

function renderStats() {
    const sumRow = document.getElementById("stats-summary-row");
    const listEl = document.getElementById("stats-subject-list");

    const answeredVals = Object.values(appState.store.answered || {});
    const totalSolved = answeredVals.length;
    const totalCorrect = answeredVals.filter((v) => v === "correct").length;
    const totalWrong = answeredVals.filter((v) => v === "wrong").length;
    const acc = totalSolved > 0 ? Math.round((totalCorrect / totalSolved) * 100) : 0;

    sumRow.innerHTML = `
        <div class="stat-card"><div class="stat-label">Questions solved</div><div class="stat-value">${totalSolved}</div></div>
        <div class="stat-card"><div class="stat-label">Correct</div><div class="stat-value fig-correct">${totalCorrect}</div></div>
        <div class="stat-card"><div class="stat-label">Incorrect</div><div class="stat-value fig-wrong">${totalWrong}</div></div>
        <div class="stat-card"><div class="stat-label">Accuracy</div><div class="stat-value">${acc}%</div></div>
        <div class="stat-card"><div class="stat-label">Time practiced</div><div class="stat-value">${formatDuration(appState.store.totalSeconds || 0)}</div></div>
    `;

    listEl.innerHTML = "";
    YEAR5_MODULES.forEach((mod) => {
        const stats = getModuleStats(mod);
        if (stats.total === 0) return;

        const card = document.createElement("div");
        card.className = "desk-row-card";
        card.style.display = "block";

        const top = document.createElement("div");
        top.style.display = "flex";
        top.style.justifyContent = "space-between";
        top.style.alignItems = "baseline";
        top.style.gap = "12px";
        top.innerHTML = `<span style="font-weight: 500;">${escapeHtml(mod.title)} <span class="topbar-subject">(${CATEGORY_LABELS[mod.category]})</span></span>
                         <span class="topbar-subject tabular">${stats.solved} / ${stats.total} · ${stats.wrong} wrong</span>`;

        const line = document.createElement("div");
        line.className = "progress-line";
        line.style.marginTop = "10px";
        const fill = document.createElement("div");
        fill.className = "progress-line-fill";
        fill.style.width = `${Math.min(100, (stats.solved / stats.total) * 100)}%`;
        line.appendChild(fill);

        card.appendChild(top);
        card.appendChild(line);
        listEl.appendChild(card);
    });
}

/* ---------------- Tools in Question Screen ---------------- */

function toggleQuestionFavorite() {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const favBtn = document.getElementById("tool-fav-btn");
    let turnedOn = false;
    if (appState.store.bookmarked[q._qid]) {
        delete appState.store.bookmarked[q._qid];
        if (favBtn) favBtn.classList.remove("is-just-fav");
    } else {
        turnedOn = true;
        appState.store.bookmarked[q._qid] = {
            moduleKey: sess.modKey,
            q: q.q,
            o: q.o,
            a: q.correctIndex,
            explanation: q.explanation,
            chapter: q._chapter
        };
    }
    cloud.scheduleSync(appState.store);
    updateToolsInPlace();
    updateMapButtonInPlace(sess.index);
    if (turnedOn && favBtn) {
        favBtn.classList.remove("is-just-fav");
        void favBtn.offsetWidth;
        favBtn.classList.add("is-just-fav");
    }
}

function saveQuestionNote() {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const txt = document.getElementById("note-input").value.trim();
    const st = document.getElementById("note-status");

    if (!txt) {
        delete appState.store.notes[q._qid];
        st.textContent = "Note cleared.";
    } else {
        appState.store.notes[q._qid] = {
            text: txt,
            moduleKey: sess.modKey,
            q: q.q,
            o: q.o,
            a: q.correctIndex,
            explanation: q.explanation,
            chapter: q._chapter,
            updatedAt: Date.now()
        };
        st.textContent = "Note saved.";
    }
    cloud.scheduleSync(appState.store);
    updateToolsInPlace();
}

async function sendQuestionReport() {
    const sess = appState.session;
    if (!sess) return;
    const q = sess.queue[sess.index];
    const reason = document.getElementById("report-input").value.trim();
    const st = document.getElementById("report-status");

    if (!reason) {
        st.className = "status-note is-error";
        st.textContent = "Enter a brief description first.";
        return;
    }

    st.className = "status-note";
    st.textContent = "Sending...";
    try {
        await cloud.submitQuestionReport({
            moduleKey: sess.modKey,
            questionId: q._qid,
            questionText: q.q,
            reason
        });
        st.className = "status-note is-ok";
        st.textContent = "Report sent.";
        setTimeout(() => document.getElementById("report-drawer").classList.remove("is-open"), 800);
    } catch (err) {
        st.className = "status-note is-error";
        st.textContent = (err && err.message) || "Could not send report.";
    }
}

/* ---------------- Misc Helpers & Event Binding ---------------- */

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function applyTheme(theme) {
    const allowed = ["light", "charcoal", "black", "navy"];
    let t = theme;
    if (t === "dark" || t === "night") t = "charcoal";
    if (t === "day") t = "light";
    if (!allowed.includes(t)) t = "charcoal";
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("thegreatasm_theme", t);
    const sel = document.getElementById("theme-select");
    if (sel) sel.value = t;
}

function initFullscreenControl() {
    const fsBtn = document.getElementById("q-fullscreen-btn");
    const fsIcon = document.getElementById("q-fs-icon");
    const fsMsg = document.getElementById("q-fs-msg");
    if (!fsBtn || !fsIcon) return;

    const rootEl = document.documentElement;
    const canRequest = Boolean(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen);
    if (!canRequest) {
        fsBtn.style.display = "none";
        return;
    }

    const showFsError = (msg) => {
        if (!fsMsg) return;
        fsMsg.textContent = msg;
        fsMsg.style.display = "block";
        setTimeout(() => {
            fsMsg.style.display = "none";
        }, 3500);
    };

    const syncFsState = () => {
        const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
        fsBtn.setAttribute("aria-label", active ? "Exit full screen" : "Enter full screen");
        fsBtn.setAttribute("title", active ? "Exit full screen" : "Enter full screen");
        fsIcon.innerHTML = active
            ? `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"></path>`
            : `<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"></path>`;
    };

    fsBtn.addEventListener("click", () => {
        const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
        try {
            if (!active) {
                const req = rootEl.requestFullscreen
                    ? rootEl.requestFullscreen()
                    : rootEl.webkitRequestFullscreen();
                if (req && typeof req.catch === "function") {
                    req.catch(() => showFsError("Full screen isn't available in this browser"));
                }
            } else {
                const exit = document.exitFullscreen
                    ? document.exitFullscreen()
                    : (document.webkitExitFullscreen ? document.webkitExitFullscreen() : null);
                if (exit && typeof exit.catch === "function") {
                    exit.catch(() => showFsError("Full screen isn't available in this browser"));
                }
            }
        } catch (_) {
            showFsError("Full screen isn't available in this browser");
        }
    });

    document.addEventListener("fullscreenchange", syncFsState);
    document.addEventListener("webkitfullscreenchange", syncFsState);
    syncFsState();
}

function bindEvents() {
    initFullscreenControl();
    const currentTheme = document.documentElement.getAttribute("data-theme") || "charcoal";
    const themeSel = document.getElementById("theme-select");
    if (themeSel) {
        themeSel.value = ["light", "charcoal", "black", "navy"].includes(currentTheme) ? currentTheme : "charcoal";
        themeSel.addEventListener("change", (e) => applyTheme(e.target.value));
    }

    document.getElementById("brand-home-btn").addEventListener("click", () => navigateTo("home"));
    document.querySelectorAll("#main-nav .text-link").forEach((btn) => {
        btn.addEventListener("click", () => navigateTo(btn.dataset.nav));
    });

    document.getElementById("topbar-signin-btn").addEventListener("click", handleGoogleSignIn);
    document.getElementById("panel-google-btn").addEventListener("click", handleGoogleSignIn);
    document.getElementById("topbar-signout-btn").addEventListener("click", () => cloud.signOutUser());

    document.getElementById("continue-local-btn").addEventListener("click", () => {
        sessionStorage.setItem("solvey_dismiss_auth", "1");
        document.getElementById("auth-prompt-panel").style.display = "none";
    });
    document.getElementById("dismiss-cfg-btn").addEventListener("click", () => {
        document.getElementById("firebase-setup-panel").style.display = "none";
    });
    document.getElementById("save-cfg-btn").addEventListener("click", () => {
        const parsed = parseRawConfigSnippet(document.getElementById("cfg-raw-input").value);
        const st = document.getElementById("cfg-status");
        if (!parsed) {
            st.className = "status-note is-error";
            st.textContent = "Could not parse apiKey and appId.";
            return;
        }
        saveFirebaseConfigOverride(parsed);
        st.className = "status-note is-ok";
        st.textContent = "Saved. Reloading...";
        setTimeout(() => window.location.reload(), 400);
    });

    // Screen 1 controls
    document.getElementById("home-search-input").addEventListener("input", (e) => {
        appState.search = e.target.value;
        renderHome();
    });

    // Screen 2 controls
    document.getElementById("setup-back-btn").addEventListener("click", () => navigateTo("home"));
    document.getElementById("lesson-search-input").addEventListener("input", (e) => {
        if (!appState.setup) return;
        appState.setup.search = e.target.value;
        renderSetupLessons();
    });
    document.getElementById("lessons-select-all-btn").addEventListener("click", () => {
        if (!appState.setup) return;
        const { allSubIds, selectedLessons } = appState.setup;
        if (selectedLessons.size === allSubIds.length) selectedLessons.clear();
        else allSubIds.forEach((id) => selectedLessons.add(id));
        renderSetupLessons();
    });

    const bindSegGroup = (id, key, afterFn) => {
        document.querySelectorAll(`#${id} .seg-btn`).forEach((btn) => {
            btn.addEventListener("click", () => {
                if (!appState.setup) return;
                appState.setup.settings[key] = btn.dataset.val;
                if (key === "timerType") {
                    appState.setup.settings.timerValue = btn.dataset.val === "per_question" ? 60 : 20;
                }
                syncSetupControlsToUI();
                if (afterFn) afterFn();
            });
        });
    };
    bindSegGroup("setup-source-group", "source", renderSetupLessons);
    bindSegGroup("setup-count-group", "countType");
    bindSegGroup("setup-order-group", "order");
    bindSegGroup("setup-mode-group", "mode");
    bindSegGroup("setup-timer-group", "timerType");

    document.getElementById("setup-custom-count-input").addEventListener("input", (e) => {
        if (!appState.setup) return;
        appState.setup.settings.customCount = parseInt(e.target.value, 10) || 10;
        updateSetupOneLineSummary();
    });
    document.getElementById("setup-timer-input").addEventListener("input", (e) => {
        if (!appState.setup) return;
        appState.setup.settings.timerValue = Math.max(5, parseInt(e.target.value, 10) || 60);
        updateSetupOneLineSummary();
    });
    document.getElementById("setup-shuffle-options").addEventListener("change", (e) => {
        if (!appState.setup) return;
        appState.setup.settings.shuffleOptions = e.target.checked;
    });
    document.getElementById("save-preset-btn").addEventListener("click", saveCurrentPreset);
    document.getElementById("start-session-btn").addEventListener("click", () => startConfiguredSession());

    // Screen 3 controls
    document.getElementById("q-map-toggle-btn").addEventListener("click", () => {
        document.getElementById("qmap-drawer").classList.toggle("is-open");
    });
    document.getElementById("q-pause-btn").addEventListener("click", pauseActiveSession);
    document.getElementById("q-finish-btn").addEventListener("click", finishActiveSession);
    document.getElementById("q-prev-btn").addEventListener("click", () => {
        if (appState.session && appState.session.index > 0) {
            jumpToQuestion(appState.session.index - 1);
        }
    });
    document.getElementById("q-next-btn").addEventListener("click", () => {
        const sess = appState.session;
        if (!sess) return;
        if (sess.index + 1 >= sess.queue.length) finishActiveSession();
        else jumpToQuestion(sess.index + 1);
    });

    document.getElementById("tool-fav-btn").addEventListener("click", toggleQuestionFavorite);
    document.getElementById("tool-note-btn").addEventListener("click", () => {
        const drawer = document.getElementById("note-drawer");
        document.getElementById("report-drawer").classList.remove("is-open");
        const isOpen = drawer.classList.toggle("is-open");
        if (isOpen && appState.session) {
            const q = appState.session.queue[appState.session.index];
            const saved = appState.store.notes[q._qid];
            document.getElementById("note-input").value = saved ? saved.text : "";
            document.getElementById("note-status").textContent = "";
        }
    });
    document.getElementById("close-note-btn").addEventListener("click", () => {
        document.getElementById("note-drawer").classList.remove("is-open");
    });
    document.getElementById("save-note-btn").addEventListener("click", saveQuestionNote);

    document.getElementById("tool-report-btn").addEventListener("click", () => {
        const drawer = document.getElementById("report-drawer");
        document.getElementById("note-drawer").classList.remove("is-open");
        const isOpen = drawer.classList.toggle("is-open");
        if (isOpen) {
            document.getElementById("report-input").value = "";
            document.getElementById("report-status").textContent = "";
        }
    });
    document.getElementById("close-report-btn").addEventListener("click", () => {
        document.getElementById("report-drawer").classList.remove("is-open");
    });
    document.getElementById("send-report-btn").addEventListener("click", sendQuestionReport);

    // Keyboard: 1-8 (4/5+ options) to answer, arrows to navigate
    document.addEventListener("keydown", (e) => {
        if (!appState.session) return;
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;

        if (/^[1-8]$/.test(e.key)) {
            const idx = parseInt(e.key, 10) - 1;
            const btn = document.querySelector(`#q-options-list .option-btn[data-index="${idx}"]`);
            if (btn && !btn.disabled) btn.click();
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            document.getElementById("q-next-btn").click();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            if (appState.session.index > 0) document.getElementById("q-prev-btn").click();
        }
    });

    // Screen 4 controls
    document.querySelectorAll("#res-filter-tabs .filter-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("#res-filter-tabs .filter-chip").forEach((b) => b.classList.remove("is-active"));
            btn.classList.add("is-active");
            appState.resultsFilter = btn.dataset.rfilter;
            renderResultsReviewList();
        });
    });
    document.getElementById("res-home-btn").addEventListener("click", () => navigateTo("home"));
    document.getElementById("res-retry-mistakes-btn").addEventListener("click", () => {
        const rec = appState.results;
        if (!rec) return;
        const missed = rec.queue.filter((q, idx) => rec.answers[idx] !== null && rec.answers[idx] !== q.correctIndex);
        if (!missed.length) return;
        const mod = YEAR5_MODULES.find((m) => m.key === rec.modKey) || YEAR5_MODULES[0];
        appState.setup = { mod, settings: { ...rec.settings } };
        startConfiguredSession(missed);
    });
    document.getElementById("res-same-settings-btn").addEventListener("click", () => {
        const rec = appState.results;
        if (!rec) return;
        const mod = YEAR5_MODULES.find((m) => m.key === rec.modKey);
        if (mod) openSessionSetup(mod, { ...rec.settings });
    });

    // Screen 5 controls
    document.getElementById("clear-history-btn").addEventListener("click", () => {
        appState.store.history = [];
        cloud.scheduleSync(appState.store);
        renderHistory();
    });
    document.getElementById("fav-search-input").addEventListener("input", renderFavorites);
    document.getElementById("fav-subject-filter").addEventListener("change", renderFavorites);

    // Live sync from Uploader
    try {
        const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
        ch.onmessage = async (ev) => {
            const msg = ev.data;
            if (msg && msg.type === "MODULE_UPDATED" && msg.docId) {
                const mod = YEAR5_MODULES.find((m) => m.docId === msg.docId);
                const cached = await getIDBCache(msg.docId);
                if (mod && cached && cached.data) {
                    appState.modulesCache[mod.key] = cached.data;
                    renderHome();
                }
            }
        };
    } catch (_) {}
}

bindEvents();
renderHome();
cloud.init().then(() => {
    updateAuthUI();
    preloadAllModules();
});
