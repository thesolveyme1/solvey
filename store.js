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
    setDoc,
    addDoc,
    collection,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getFirebaseConfig, isFirebaseConfigured } from "./firebase-config.js";
import {
    YEAR5_MODULES,
    loadFallbackModuleData,
    getIDBCache,
    setIDBCache,
    mergeChunkObjects
} from "./data-catalog.js";

const STORAGE_KEY = "solvey_desk_state_v1";

export function defaultUserData() {
    return {
        answered: {},         // { qId: 'correct' | 'wrong' }
        wrongCounts: {},      // { qId: number }
        attemptCounts: {},    // { qId: number }
        bookmarked: {},       // { qId: { moduleKey, q, o, a, explanation, chapter } | true }
        notes: {},            // { qId: { text, moduleKey, q, o, a, explanation, chapter, updatedAt } }
        presets: [],          // [{ id, name, settings }]
        pendingSessions: [],  // [{ id, modKey, settings, queue, answers, struck, index, elapsedSec, qTimeLeft, sessionTimeLeft, savedAt }]
        history: [],          // [{ id, modKey, modTitle, settings, queue, answers, correct, wrong, skipped, durationSec, finishedAt }]
        totalSeconds: 0
    };
}

export function loadLocalStore() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return Object.assign(defaultUserData(), parsed || {});
        }
    } catch (_) {}
    return defaultUserData();
}

export function saveLocalStore(data) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
}

export function createCloudBridge({ onUserChanged, onDataMerged }) {
    const bridge = {
        ready: false,
        auth: null,
        db: null,
        user: null,
        syncTimer: null,
        cloudMetadata: null
    };

    async function init() {
        const cfg = getFirebaseConfig();
        if (!isFirebaseConfigured(cfg)) {
            bridge.ready = false;
            return false;
        }
        try {
            const app = initializeApp(cfg);
            bridge.auth = getAuth(app);
            bridge.db = getFirestore(app);
            bridge.ready = true;

            try {
                await getRedirectResult(bridge.auth);
            } catch (_) {}

            onAuthStateChanged(bridge.auth, async (user) => {
                bridge.user = user || null;
                if (onUserChanged) onUserChanged(bridge.user);
                if (user) {
                    await pullUserData(user);
                }
            });

            // Fetch lightweight metadata doc once if available
            try {
                const metaSnap = await getDoc(doc(bridge.db, "content", "metadata"));
                if (metaSnap.exists()) {
                    bridge.cloudMetadata = metaSnap.data() || {};
                }
            } catch (_) {}

            return true;
        } catch (err) {
            console.warn("Firebase init error:", err);
            return false;
        }
    }

    async function signInGoogle() {
        if (!bridge.ready || !bridge.auth) throw new Error("Firebase is not configured");
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        try {
            await signInWithPopup(bridge.auth, provider);
        } catch (err) {
            if (err && (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment")) {
                await signInWithRedirect(bridge.auth, provider);
                return;
            }
            throw err;
        }
    }

    async function signOutUser() {
        if (bridge.auth) await signOut(bridge.auth);
    }

    async function pullUserData(user) {
        if (!bridge.db || !user) return null;
        try {
            const snap = await getDoc(doc(bridge.db, "users", user.uid));
            if (snap.exists() && onDataMerged) {
                onDataMerged(snap.data() || {});
            }
        } catch (err) {
            console.warn("Remote user fetch error:", err);
        }
        return null;
    }

    function scheduleSync(storeData) {
        saveLocalStore(storeData);
        if (!bridge.ready || !bridge.db || !bridge.user) return;
        clearTimeout(bridge.syncTimer);
        bridge.syncTimer = setTimeout(async () => {
            try {
                // Trim history/pending to keep user document compact
                const compactHistory = (storeData.history || []).slice(0, 30);
                const compactPending = (storeData.pendingSessions || []).slice(0, 8);
                await setDoc(
                    doc(bridge.db, "users", bridge.user.uid),
                    {
                        email: bridge.user.email || "",
                        displayName: bridge.user.displayName || "",
                        answered: storeData.answered || {},
                        wrongCounts: storeData.wrongCounts || {},
                        attemptCounts: storeData.attemptCounts || {},
                        bookmarked: storeData.bookmarked || {},
                        notes: storeData.notes || {},
                        presets: storeData.presets || [],
                        pendingSessions: compactPending,
                        history: compactHistory,
                        totalSeconds: storeData.totalSeconds || 0,
                        updatedAt: serverTimestamp()
                    },
                    { merge: true }
                );
            } catch (err) {
                console.warn("User sync error:", err);
            }
        }, 900);
    }

    async function submitQuestionReport(payload) {
        if (!bridge.ready || !bridge.db) throw new Error("Firebase is not connected.");
        await addDoc(collection(bridge.db, "reports"), {
            ...payload,
            userUid: bridge.user ? bridge.user.uid : null,
            userEmail: bridge.user ? bridge.user.email : null,
            createdAt: serverTimestamp()
        });
    }

    async function loadModuleTree(mod, modulesCache, cloudChecked) {
        const remoteTs = bridge.cloudMetadata ? bridge.cloudMetadata[`${mod.docId}_updatedAt`] : 0;
        const idbEntry = await getIDBCache(mod.docId);

        if (idbEntry && idbEntry.data && (!remoteTs || (idbEntry.updatedAt && idbEntry.updatedAt >= remoteTs))) {
            modulesCache[mod.key] = idbEntry.data;
            return idbEntry.data;
        }

        if (bridge.ready && bridge.db && !cloudChecked[mod.key]) {
            cloudChecked[mod.key] = true;
            try {
                const snap = await getDoc(doc(bridge.db, "content", mod.docId));
                if (snap.exists()) {
                    let data = snap.data();
                    if (data && data._isChunked && data._chunkCount > 1) {
                        const parts = [];
                        for (let i = 1; i < data._chunkCount; i++) {
                            parts.push(getDoc(doc(bridge.db, "content", `${mod.docId}_chunk_${i}`)));
                        }
                        const resolved = await Promise.all(parts);
                        let merged = Object.assign({}, data);
                        delete merged._isChunked;
                        delete merged._chunkCount;
                        delete merged._updatedAt;
                        for (const cs of resolved) {
                            if (cs.exists()) merged = mergeChunkObjects(merged, cs.data());
                        }
                        data = merged;
                    } else if (data) {
                        const clean = Object.assign({}, data);
                        delete clean._updatedAt;
                        data = clean;
                    }
                    if (data && Object.keys(data).length > 0) {
                        modulesCache[mod.key] = data;
                        await setIDBCache(mod.docId, { data, updatedAt: remoteTs || Date.now() });
                        return data;
                    }
                }
            } catch (err) {
                console.warn(`Firestore load error for ${mod.docId}:`, err);
            }
        }

        if (modulesCache[mod.key]) return modulesCache[mod.key];
        const fallback = await loadFallbackModuleData(mod);
        if (fallback) {
            modulesCache[mod.key] = fallback;
            return fallback;
        }
        return null;
    }

    return {
        bridge,
        init,
        signInGoogle,
        signOutUser,
        scheduleSync,
        submitQuestionReport,
        loadModuleTree
    };
}

export function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(rem)}` : `${pad(mins)}:${pad(rem)}`;
}
