// Year 5 question catalog, IndexedDB cache, BroadcastChannel sync, and fallback loader

export const YEAR5_MODULES = [
    // Rounds (8)
    { key: "Rounds Anesthesia & Critical Care", title: "Anesthesia & Critical Care", category: "rounds", docId: "rounds_anesthesia", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Anesthesia & Critical Care" },
    { key: "Rounds ENT", title: "ENT", category: "rounds", docId: "rounds_ent", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "ENT" },
    { key: "Rounds Family Medicine", title: "Family Medicine", category: "rounds", docId: "rounds_family_medicine", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Family Medicine" },
    { key: "Rounds Obstetrics & Gynecology", title: "Obstetrics & Gynecology", category: "rounds", docId: "rounds_obgyn", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Obstetrics & Gynecology" },
    { key: "Rounds Ophthalmology", title: "Ophthalmology", category: "rounds", docId: "rounds_ophthalmology", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Ophthalmology" },
    { key: "Rounds Orthopedic Surgery", title: "Orthopedic Surgery", category: "rounds", docId: "rounds_orthopedics", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Orthopedic Surgery" },
    { key: "Rounds Pediatrics", title: "Pediatrics", category: "rounds", docId: "rounds_pediatrics", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Pediatrics" },
    { key: "Rounds Toxicology & Emergency Medicine", title: "Toxicology & Emergency Medicine", category: "rounds", docId: "rounds_toxicology", script: "../year5_rounds.js", rootVar: "YEAR5_ROUNDS", subjectKey: "Toxicology & Emergency Medicine" },

    // Ends (6)
    { key: "End Anesthesia & Critical Care", title: "Anesthesia & Critical Care", category: "ends", docId: "end_anesthesia", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "Anesthesia & Critical Care" },
    { key: "End ENT", title: "ENT", category: "ends", docId: "end_ent", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "ENT" },
    { key: "End Ophthalmology", title: "Ophthalmology", category: "ends", docId: "end_ophthalmology", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "Ophthalmology" },
    { key: "End Orthopedic Surgery", title: "Orthopedic Surgery", category: "ends", docId: "end_orthopedics", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "Orthopedic Surgery" },
    { key: "End Pediatrics", title: "Pediatrics", category: "ends", docId: "end_pediatrics", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "Pediatrics" },
    { key: "End Toxicology & Emergency Medicine", title: "Toxicology & Emergency Medicine", category: "ends", docId: "end_toxicology", script: "../year5_end.js", rootVar: "YEAR5_END", subjectKey: "Toxicology & Emergency Medicine" },

    // Finals (8)
    { key: "Final Anesthesia & Critical Care", title: "Anesthesia & Critical Care", category: "finals", docId: "final_anesthesia", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Anesthesia & Critical Care" },
    { key: "Final ENT", title: "ENT", category: "finals", docId: "final_ent", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "ENT" },
    { key: "Final Family Medicine", title: "Family Medicine", category: "finals", docId: "final_family_medicine", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Family Medicine" },
    { key: "Final Obstetrics & Gynecology", title: "Obstetrics & Gynecology", category: "finals", docId: "final_obgyn", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Obstetrics & Gynecology" },
    { key: "Final Ophthalmology", title: "Ophthalmology", category: "finals", docId: "final_ophthalmology", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Ophthalmology" },
    { key: "Final Orthopedic Surgery", title: "Orthopedic Surgery", category: "finals", docId: "final_orthopedics", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Orthopedic Surgery" },
    { key: "Final Pediatrics", title: "Pediatrics", category: "finals", docId: "final_pediatrics", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Pediatrics" },
    { key: "Final Toxicology & Emergency Medicine", title: "Toxicology & Emergency Medicine", category: "finals", docId: "final_toxicology", script: "../year5_final.js", rootVar: "YEAR5_FINAL", subjectKey: "Toxicology & Emergency Medicine" }
];

export const CATEGORY_LABELS = {
    rounds: "Rounds",
    ends: "Ends",
    finals: "Finals"
};

export const SYNC_CHANNEL_NAME = "thegreatasm_sync";
const IDB_NAME = "TheGreatAsmQuestionsDB";
const IDB_STORE = "modules";

const scriptPromises = {};

export function loadScriptOnce(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = src;
        el.async = true;
        el.onload = () => resolve(true);
        el.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(el);
    });
    return scriptPromises[src];
}

export async function loadFallbackModuleData(mod) {
    try {
        await loadScriptOnce(mod.script);
        const root = window[mod.rootVar];
        return root && root[mod.subjectKey] ? root[mod.subjectKey] : null;
    } catch (_) {
        return null;
    }
}

export function extractQuestions(node, chapterPath = "") {
    const list = [];
    if (!node) return list;
    if (Array.isArray(node)) {
        for (const item of node) {
            if (item && typeof item === "object" && (item.q || Array.isArray(item.o))) {
                list.push({
                    ...item,
                    _chapter: item.chapter || chapterPath || ""
                });
            }
        }
        return list;
    }
    if (typeof node === "object") {
        for (const key of Object.keys(node)) {
            const cleanKey = key.replace(/^\d+\.\s*/, "");
            const nextPath = chapterPath ? `${chapterPath} / ${cleanKey}` : cleanKey;
            list.push(...extractQuestions(node[key], nextPath));
        }
    }
    return list;
}

export function getQuestionId(q, moduleKey = "") {
    if (q && q.id) return String(q.id);
    const stem = String((q && q.q) || "").trim();
    const opts = Array.isArray(q && q.o) ? q.o.join("|") : "";
    const str = `${moduleKey}::${stem}::${opts}`;
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return `q_${(hash >>> 0).toString(36)}`;
}

export function resolveMediaPath(src) {
    if (!src || typeof src !== "string") return "";
    const trimmed = src.trim();
    if (!trimmed) return "";
    if (/^(https?:|data:|blob:|\/|\.\.\/)/i.test(trimmed)) return trimmed;
    return `../${trimmed.replace(/^\.\//, "")}`;
}

export function hasArabic(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(String(text || ""));
}

// IndexedDB helpers
function openIDB() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error("IndexedDB unavailable"));
            return;
        }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

export async function getIDBCache(key) {
    try {
        const db = await openIDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (_) {
        return null;
    }
}

export async function setIDBCache(key, value) {
    try {
        const db = await openIDB();
        await new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (_) {
        // Ignore IDB errors
    }
}

export function mergeChunkObjects(baseObj, chunkObj) {
    const out = Object.assign({}, baseObj || {});
    if (!chunkObj || typeof chunkObj !== "object") return out;
    for (const key of Object.keys(chunkObj)) {
        if (key === "_isChunked" || key === "_chunkCount" || key === "_updatedAt") continue;
        if (Array.isArray(out[key]) && Array.isArray(chunkObj[key])) {
            out[key] = out[key].concat(chunkObj[key]);
        } else if (
            out[key] &&
            typeof out[key] === "object" &&
            !Array.isArray(out[key]) &&
            chunkObj[key] &&
            typeof chunkObj[key] === "object" &&
            !Array.isArray(chunkObj[key])
        ) {
            out[key] = mergeChunkObjects(out[key], chunkObj[key]);
        } else {
            out[key] = chunkObj[key];
        }
    }
    return out;
}
