# Solvey QA & Manual Test Checklist

Use a local server (for example `http://localhost:5500/thegreatasm/index.html`) with a test/blanked Firebase config (`localStorage` override or Firebase Local Emulator Suite) so production user data is untouched.

## 1. Automated & Static Verification (Pre-flight)
- [ ] All JS modules (`firebase-config.js`, `data-catalog.js`, `store.js`, `app.js`, `uploader.js`) and inline HTML scripts parse without syntax errors.
- [ ] Zero missing DOM IDs between `app.js` / `uploader.js` and `index.html` / `uploader.html`.
- [ ] Contrast ratio >= 4.5:1 verified across `light`, `charcoal`, `black`, and `navy`.

## 2. Modes & Question Edge Cases
- [ ] **Learning mode — Correct:** Select a correct answer -> green `#22c55e` border + tint (`#e7f8ee` light / `rgba(34,197,94,.14)` dark), checkmark SVG draws in (`200ms`), `"Correct"` label slides in (`180ms`), `aria-live="polite"` announces `"Correct"`, letter badge stays visible. Navigate away and back (`Previous` / `Next`) -> static green without re-animating.
- [ ] **Learning mode — Wrong:** Select a wrong answer -> ONLY the chosen option shakes once (`320ms`), red `#ef4444` border + tint, X icon + `"Wrong"` label; true correct option highlights immediately without waiting for shake. Page/card does NOT shake or cause horizontal scroll.
- [ ] **Exam mode:** Selecting any option applies neutral selected style only (`--selected-bg`, `--selected-border`), NO green/red/icons/shake until `Finish`.
- [ ] **4-option and 5-option (and up to 8-option) questions:** Open e.g. `Pediatrics` or `Obstetrics & Gynecology` 5-option questions -> letter badges `A–E` render cleanly and keys `1`–`5` trigger options `A`–`E`.
- [ ] **Longest question (~1271 chars in Rounds ObGyn) & longest option (~301 chars in Final Pediatrics):** Full text wraps cleanly inside the `720px` card with zero clipping or horizontal scroll; explanation box shows even `16px` padding with no blank line between `"EXPLANATION"` label and `#q-explanation-text`.
- [ ] **No explanation (5 questions in dataset):** Verify `.explanation-block` remains hidden (no empty box).

## 3. Session Controls, Timers & Tools
- [ ] **Setup controls:** Source (`Unsolved`, `Mistakes`, `Favorites`, `All`) fits on one row at desktop width (`1280px`) and wraps cleanly on mobile (`360px`/`390px`); sticky panel keeps `Start session` visible on desktop without scrolling long lesson lists; fixed bottom `Start session` bar on mobile leaves `Save preset` and summary visible above it.
- [ ] **Per-question & whole-session timers + Pause:** Start timed session -> `Pause` returns Home and shows `Continue: <subject>` strip -> `Resume` restores exact question, answers, and timer -> `Discard` removes it.
- [ ] **Tools & Map:** Test `Favorite` (`150ms` icon pop on toggle on), `Note`, `Report`, per-option `44px` square strike-out button, `Map` drawer jump, `Finish` -> Results filter tabs (`All`, `Incorrect`, `Correct`, `Skipped`) -> `Retry mistakes only` / `Same settings again`.
- [ ] **Keyboard shortcuts:** `1–5` (up to `8`) answer options, `ArrowLeft` / `ArrowRight` navigate questions, `Tab` shows clear focus rings on all controls.
- [ ] **Fullscreen toggle:** Click expand button next to `Map` -> enters fullscreen and swaps to shrink icon; press `Esc` -> exits fullscreen and icon returns to expand without resetting session, timer, answers, or scroll; verify unsupported browser hides button or displays `"Full screen isn't available in this browser"`.

## 4. Themes, Reduced Motion & Responsive Viewports (`1280px`, `360px`, `390px`)
- [ ] **All 4 themes (`Light`, `Charcoal`, `Black`, `Dark blue`):** Switch via topbar `<select>` -> applies immediately across Home, Setup, Question, Results, History, Favorites, Mistakes, Stats; reload confirms no flash of wrong theme; `Black` shows card border with no drop shadow.
- [ ] **Reduced motion:** Toggle OS / DevTools `prefers-reduced-motion: reduce` -> no shake, slide, scale, or animated progress bar; instant color/icon update.
- [ ] **Desktop (`1280px`):** Question topbar (`Subject` left, `Finish` right) aligns vertically with the `720px` card edges while the `3px` progress line spans full viewport width.
- [ ] **Mobile (`360px` & `390px`):**
  - Top header puts brand + theme picker on Row 1 and non-wrapping horizontal nav (`Subjects`, `Mistakes`, `Favorites`, `History`, `Stats`) on Row 2.
  - Subjects Home stacks each subject with type boxes below (`min-height: 44px`).
  - Question topbar shows single-line truncated subject + counter beside it + `44px` icon-only buttons (`Fullscreen`, `Map`, `Pause`, `Finish`), zero horizontal overflow (`scrollWidth <= innerWidth`).
- [ ] **RTL / Arabic text (if encountered):** Verify `dir="rtl"` auto-applies cleanly on question stems, options, and explanations.

## 5. Manual Google Sign-In & Cloud Sync Checklist (Run Separately)
- [ ] Use a test Google account / Firebase project copy or local Firestore Emulator.
- [ ] Sign in with Google -> topbar displays user name and `Sign out`.
- [ ] Answer a question, favorite, add a note, pause a session -> reload or open in a second tab -> verify `answered`, `bookmarked`, `notes`, `pendingSessions`, and `history` sync cleanly.
- [ ] Sign out -> verify clean return to local mode without crashing.
