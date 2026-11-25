import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import {
    getFirebaseConfig,
    saveFirebaseConfigOverride,
    isFirebaseConfigured
} from "./firebase-config.js";

import {
    YEAR5_MODULES,
    CATEGORY_LABELS,
    SYNC_CHANNEL_NAME,
    loadFallbackModuleData,
    extractQuestions,
    setIDBCache
} from "./data-catalog.js";

const MAX_CHUNK_BYTES = 550 * 1024; // safe margin under Firestore 1 MiB & index limits

const state = {
    firebaseReady: false,
    auth: null,
    db: null,
    user: null,
    loadedData: {},     // { modKey: rawTree }
    remoteStatus: {},   // { docId: { exists, total, chunked } }
    busy: false
};

let syncChannel = null;
try {
    syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
} catch (_) {}

function setGlobalStatus(msg, isError = false) {
    const el = document.getElementById("up-global-status");
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? "status-note is-error" : "status-note";
}

function parseRawConfigSnippet(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return null;
    try {
        const jsonAttempt = JSON.parse(trimmed);
        if (jsonAttempt && jsonAttempt.apiKey) return jsonAttempt;
    } catch (_) {}

    const extract = (key) => {
        const re = new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`);
        const m = trimmed.match(re);
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

function updateThemeButton() {
    const btn = document.getElementById("up-theme-btn");
    const isNight = document.documentElement.getAttribute("data-theme") === "night";
    if (btn) btn.textContent = isNight ? "Day" : "Night";
}

function updateAuthUI() {
    const signInBtn = document.getElementById("up-signin-btn");
    const userLbl = document.getElementById("up-user-label");
    const signOutBtn = document.getElementById("up-signout-btn");
    const allBtn = document.getElementById("up-all-btn");
    const refBtn = document.getElementById("up-refresh-btn");

    if (!state.firebaseReady) {
        signInBtn.style.display = "none";
        userLbl.style.display = "none";
        signOutBtn.style.display = "none";
        allBtn.disabled = true;
        refBtn.disabled = true;
        return;
    }

    if (state.user) {
        signInBtn.style.display = "none";
        userLbl.textContent = state.user.displayName || state.user.email || "Signed in";
        userLbl.style.display = "inline";
        signOutBtn.style.display = "inline";
        allBtn.disabled = state.busy || Object.keys(state.loadedData).length === 0;
        refBtn.disabled = state.busy;
    } else {
        signInBtn.style.display = "inline";
        userLbl.style.display = "none";
        signOutBtn.style.display = "none";
        allBtn.disabled = true;
        refBtn.disabled = false;
    }
}

async function handleGoogleSignIn() {
    if (!state.firebaseReady || !state.auth) return;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
        await signInWithPopup(state.auth, provider);
    } catch (err) {
        if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
            await signInWithRedirect(state.auth, provider);
        } else {
            setGlobalStatus((err && err.message) || "Google sign-in failed.", true);
        }
    }
}

async function initFirebase() {
    const cfg = getFirebaseConfig();
    const setupPanel = document.getElementById("up-setup-panel");
    if (!isFirebaseConfigured(cfg)) {
        setupPanel.style.display = "block";
        updateAuthUI();
        return;
    }
    setupPanel.style.display = "none";

    const app = initializeApp(cfg);
    state.auth = getAuth(app);
    state.db = getFirestore(app);
    state.firebaseReady = true;

    try {
        await getRedirectResult(state.auth);
    } catch (_) {}

    onAuthStateChanged(state.auth, async (user) => {
        state.user = user || null;
        updateAuthUI();
        if (user) {
            await refreshRemoteMetadata();
        }
    });

    updateAuthUI();
    await refreshRemoteMetadata();
}

async function refreshRemoteMetadata() {
    if (!state.firebaseReady || !state.db) return;
    try {
        const metaSnap = await getDoc(doc(state.db, "content", "metadata"));
        const meta = metaSnap.exists() ? metaSnap.data() || {} : {};
        for (const mod of YEAR5_MODULES) {
            const ts = meta[`${mod.docId}_updatedAt`];
            const total = meta[`${mod.docId}_total`];
            state.remoteStatus[mod.docId] = {
                exists: Boolean(ts),
                total: total || 0,
                updatedAt: ts || 0
            };
        }
        renderModulesList();
    } catch (err) {
        console.warn("Metadata check failed:", err);
    }
}

function splitTreeIntoChunks(treeData) {
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(JSON.stringify(treeData)).length;
    if (fullBytes <= MAX_CHUNK_BYTES) {
        return [treeData];
    }

    const chunks = [];
    let current = {};
    let currentBytes = 2;

    const pushCurrent = () => {
        if (Object.keys(current).length > 0) {
            chunks.push(current);
            current = {};
            currentBytes = 2;
        }
    };

    for (const topKey of Object.keys(treeData)) {
        const val = treeData[topKey];
        const entryBytes = encoder.encode(JSON.stringify({ [topKey]: val })).length;

        if (entryBytes <= MAX_CHUNK_BYTES) {
            if (currentBytes + entryBytes > MAX_CHUNK_BYTES) {
                pushCurrent();
            }
            current[topKey] = val;
            currentBytes += entryBytes;
        } else if (Array.isArray(val)) {
            pushCurrent();
            let part = [];
            for (const q of val) {
                const candidate = part.concat([q]);
                const candBytes = encoder.encode(JSON.stringify({ [topKey]: candidate })).length;
                if (candBytes > MAX_CHUNK_BYTES && part.length > 0) {
                    chunks.push({ [topKey]: part });
                    part = [q];
                } else {
                    part = candidate;
                }
            }
            if (part.length > 0) chunks.push({ [topKey]: part });
        } else if (val && typeof val === "object") {
            pushCurrent();
            let subGroup = {};
            for (const subKey of Object.keys(val)) {
                const subVal = val[subKey];
                const singleSubBytes = encoder.encode(JSON.stringify({ [topKey]: { [subKey]: subVal } })).length;
                if (singleSubBytes > MAX_CHUNK_BYTES && Array.isArray(subVal)) {
                    if (Object.keys(subGroup).length > 0) {
                        chunks.push({ [topKey]: subGroup });
                        subGroup = {};
                    }
                    let part = [];
                    for (const q of subVal) {
                        const candidate = part.concat([q]);
                        if (encoder.encode(JSON.stringify({ [topKey]: { [subKey]: candidate } })).length > MAX_CHUNK_BYTES && part.length > 0) {
                            chunks.push({ [topKey]: { [subKey]: part } });
                            part = [q];
                        } else {
                            part = candidate;
                        }
                    }
                    if (part.length > 0) chunks.push({ [topKey]: { [subKey]: part } });
                } else {
                    const subObj = { [topKey]: { ...subGroup, [subKey]: subVal } };
                    if (encoder.encode(JSON.stringify(subObj)).length > MAX_CHUNK_BYTES && Object.keys(subGroup).length > 0) {
                        chunks.push({ [topKey]: subGroup });
                        subGroup = { [subKey]: subVal };
                    } else {
                        subGroup[subKey] = subVal;
                    }
                }
            }
            if (Object.keys(subGroup).length > 0) chunks.push({ [topKey]: subGroup });
        }
    }

    pushCurrent();
    return chunks.length > 0 ? chunks : [treeData];
}

async function uploadSingleModule(mod, rowStatusEl = null) {
    if (!state.firebaseReady || !state.db) {
        setGlobalStatus("Connect Firebase first.", true);
        return false;
    }
    if (!state.user) {
        setGlobalStatus("Sign in with Google before uploading.", true);
        return false;
    }

    const rawData = state.loadedData[mod.key];
    if (!rawData || Object.keys(rawData).length === 0) {
        if (rowStatusEl) rowStatusEl.textContent = "Local data missing";
        return false;
    }

    const totalQs = extractQuestions(rawData).length;
    const chunks = splitTreeIntoChunks(rawData);
    const now = Date.now();

    if (rowStatusEl) {
        rowStatusEl.textContent = chunks.length > 1 ? `Uploading (${chunks.length} parts)...` : "Uploading...";
    }

    try {
        const mainPayload = Object.assign({}, chunks[0], {
            _updatedAt: now
        });
        if (chunks.length > 1) {
            mainPayload._isChunked = true;
            mainPayload._chunkCount = chunks.length;
        }
        await setDoc(doc(state.db, "content", mod.docId), mainPayload);

        for (let i = 1; i < chunks.length; i++) {
            await setDoc(doc(state.db, "content", `${mod.docId}_chunk_${i}`), chunks[i]);
        }

        await setDoc(
            doc(state.db, "content", "metadata"),
            {
                [`${mod.docId}_updatedAt`]: now,
                [`${mod.docId}_total`]: totalQs
            },
            { merge: true }
        );

        await setIDBCache(mod.docId, { data: rawData, updatedAt: now });
        if (syncChannel) {
            syncChannel.postMessage({ type: "MODULE_UPDATED", docId: mod.docId, updatedAt: now });
        }

        state.remoteStatus[mod.docId] = { exists: true, total: totalQs, updatedAt: now };
        if (rowStatusEl) {
            rowStatusEl.textContent = chunks.length > 1 ? `Synced (${chunks.length} parts)` : "Synced";
        }
        return true;
    } catch (err) {
        console.error(`Upload failed for ${mod.docId}:`, err);
        if (rowStatusEl) rowStatusEl.textContent = (err && err.code) || "Upload failed";
        return false;
    }
}

async function uploadAllModules() {
    if (state.busy) return;
    if (!state.user) {
        setGlobalStatus("Sign in with Google before uploading.", true);
        return;
    }
    state.busy = true;
    updateAuthUI();

    let done = 0;
    let failed = 0;
    for (const mod of YEAR5_MODULES) {
        setGlobalStatus(`Uploading ${done + 1} of ${YEAR5_MODULES.length}: ${mod.title}`);
        const statusEl = document.getElementById(`status-${mod.docId}`);
        const ok = await uploadSingleModule(mod, statusEl);
        if (ok) done++;
        else failed++;
    }

    state.busy = false;
    updateAuthUI();
    setGlobalStatus(
        failed === 0
            ? `Uploaded ${done} of ${YEAR5_MODULES.length} modules to solvey-4cc26.`
            : `Uploaded ${done} modules, ${failed} failed.`,
        failed > 0
    );
}

function renderModulesList() {
    const container = document.getElementById("up-modules-container");
    if (!container) return;
    container.innerHTML = "";

    const categories = ["rounds", "ends", "finals"];
    for (const cat of categories) {
        const heading = document.createElement("h2");
        heading.className = "uploader-group-title";
        heading.textContent = CATEGORY_LABELS[cat];
        container.appendChild(heading);

        const ul = document.createElement("ul");
        ul.className = "subject-list";

        for (const mod of YEAR5_MODULES.filter((m) => m.category === cat)) {
            const localTree = state.loadedData[mod.key];
            const totalQs = localTree ? extractQuestions(localTree).length : 0;
            const rem = state.remoteStatus[mod.docId];

            const li = document.createElement("li");
            li.className = "subject-row";

            const main = document.createElement("div");
            main.className = "subject-row-main";

            const title = document.createElement("span");
            title.className = "subject-btn";
            title.style.cursor = "default";
            title.textContent = mod.title;

            const right = document.createElement("div");
            right.className = "subject-meta";

            const count = document.createElement("span");
            count.textContent = totalQs ? `${totalQs} Qs` : "Not loaded";

            const st = document.createElement("span");
            st.id = `status-${mod.docId}`;
            if (rem && rem.exists) {
                st.textContent = "In Firestore";
            } else {
                st.textContent = "Local only";
            }

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "text-link is-accent";
            btn.textContent = "Upload";
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                await uploadSingleModule(mod, st);
                btn.disabled = false;
            });

            right.appendChild(count);
            right.appendChild(st);
            right.appendChild(btn);

            main.appendChild(title);
            main.appendChild(right);
            li.appendChild(main);
            ul.appendChild(li);
        }

        container.appendChild(ul);
    }
}

async function preloadLocalSources() {
    setGlobalStatus("Loading local Year 5 files...");
    for (const mod of YEAR5_MODULES) {
        const data = await loadFallbackModuleData(mod);
        if (data) state.loadedData[mod.key] = data;
    }
    const loadedCount = Object.keys(state.loadedData).length;
    setGlobalStatus(`${loadedCount} of ${YEAR5_MODULES.length} local modules ready.`);
    renderModulesList();
    updateAuthUI();
}

document.getElementById("up-theme-btn").addEventListener("click", () => {
    const root = document.documentElement;
    const isNight = root.getAttribute("data-theme") === "night";
    if (isNight) {
        root.removeAttribute("data-theme");
        localStorage.setItem("thegreatasm_theme", "day");
    } else {
        root.setAttribute("data-theme", "night");
        localStorage.setItem("thegreatasm_theme", "night");
    }
    updateThemeButton();
});

document.getElementById("up-signin-btn").addEventListener("click", handleGoogleSignIn);
document.getElementById("up-signout-btn").addEventListener("click", async () => {
    if (state.auth) await signOut(state.auth);
});
document.getElementById("up-all-btn").addEventListener("click", uploadAllModules);
document.getElementById("up-refresh-btn").addEventListener("click", refreshRemoteMetadata);

document.getElementById("up-save-cfg-btn").addEventListener("click", () => {
    const parsed = parseRawConfigSnippet(document.getElementById("up-cfg-input").value);
    const st = document.getElementById("up-cfg-status");
    if (!parsed) {
        st.className = "status-note is-error";
        st.textContent = "Could not find apiKey and appId in that snippet.";
        return;
    }
    saveFirebaseConfigOverride(parsed);
    st.className = "status-note is-ok";
    st.textContent = "Configuration saved. Reloading...";
    setTimeout(() => window.location.reload(), 500);
});

updateThemeButton();
renderModulesList();
preloadLocalSources();
initFirebase();
