// Firebase configuration for project: solvey-4cc26
// https://console.firebase.google.com/u/2/project/solvey-4cc26
// Paste your Web App credentials from Project Settings -> General -> Your apps below.

export const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyD1slU8_c5up1f7_xk73jtA-GBHXDMOFsI",
    authDomain: "solvey-4cc26.firebaseapp.com",
    projectId: "solvey-4cc26",
    storageBucket: "solvey-4cc26.firebasestorage.app",
    messagingSenderId: "162470680667",
    appId: "1:162470680667:web:cfe70e44fd2864cfac877e",
    measurementId: "G-2JQ1N4NNB4"
};

const OVERRIDE_STORAGE_KEY = "thegreatasm_firebase_config_override";

export function getFirebaseConfig() {
    try {
        const raw = localStorage.getItem(OVERRIDE_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.apiKey && parsed.projectId) {
                return {
                    apiKey: String(parsed.apiKey).trim(),
                    authDomain: String(parsed.authDomain || `${parsed.projectId}.firebaseapp.com`).trim(),
                    projectId: String(parsed.projectId).trim(),
                    storageBucket: String(parsed.storageBucket || `${parsed.projectId}.firebasestorage.app`).trim(),
                    messagingSenderId: String(parsed.messagingSenderId || "").trim(),
                    appId: String(parsed.appId || "").trim()
                };
            }
        }
    } catch (_) {
        // Ignore malformed local override
    }
    return DEFAULT_FIREBASE_CONFIG;
}

export function saveFirebaseConfigOverride(cfg) {
    localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(cfg));
}

export function clearFirebaseConfigOverride() {
    localStorage.removeItem(OVERRIDE_STORAGE_KEY);
}

export function isFirebaseConfigured(cfg = getFirebaseConfig()) {
    if (!cfg || !cfg.apiKey || !cfg.projectId || !cfg.appId) return false;
    return !cfg.apiKey.startsWith("PASTE_") && !cfg.appId.startsWith("PASTE_");
}
