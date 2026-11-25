// Daily Hero Roast Banner — Africa/Cairo day rollover, DOM-only text nodes, zero persistence

const ROAST_MESSAGES = [
    [
        { text: "You shouldn't have to pay a fortune just to " },
        { text: "gain", type: "gold" },
        { text: " a good " },
        { text: "grade", type: "gold" },
        { text: ", especially not with 'exam-week inflation.' Everything here is 100% free, with zero monopoly vibes." }
    ],
    [
        { text: "Welcome! Unlike some " },
        { text: "other", type: "em" },
        { text: " platforms, we don't suddenly double our prices the night before the exam just because you're desperate. No 'last-minute panic tax' here, just 100% free questions." }
    ],
    [
        { text: "Zero Monopoly. Zero Exam-Night Price Hikes. 100% Free. Because education shouldn't be a hostage situation right before finals." }
    ],
    [
        { text: "Warning: This site is completely free. If you enjoy getting overcharged 48 hours before finals by people who think they own the curriculum, you're in the wrong place." }
    ],
    [
        { text: "Save your money for post-exam therapy. All the questions you need are right here, 100% free, with zero greed." }
    ],
    [
        { text: "Plot twist: Nobody actually owns the university curriculum. Here are all the practice questions you need, completely free, zero gatekeeping." }
    ],
    [
        { text: "Our pricing algorithm is super simple: $0 before midterms, $0 during finals, and $0 when you're panicking at 3 AM." }
    ],
    [
        { text: "Why pay someone else to copy-paste Google questions into a locked PDF when you can practice them here for free?" }
    ],
    [
        { text: "We believe the only thing that should drop during exam week is your stress level, not your bank balance." }
    ],
    [
        { text: "No 'Emergency Final-Night Bundles.' No 'VIP Access.' Just good old-fashioned free education without the greedy middleman." }
    ],
    [
        { text: "Keep your wallet in your pocket. The only currency we accept here is caffeine-fueled panic and late-night studying." }
    ],
    [
        { text: "Supply and demand is great for economics class, terrible when used to extort stressed college students. Everything here stays free." }
    ],
    [
        { text: "The only thing " },
        { text: "gaining", type: "gold" },
        { text: " here is your GPA, definitely not our bank account. 100% free, forever." }
    ],
    [
        { text: "Built by students who actually care about passing, not profiting off your exam anxiety. Welcome aboard!" }
    ]
];

export function getCairoDayNumber(dateObj = new Date()) {
    try {
        const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Africa/Cairo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        });
        const parts = fmt.formatToParts(dateObj);
        const y = Number(parts.find((p) => p.type === "year").value);
        const m = Number(parts.find((p) => p.type === "month").value);
        const d = Number(parts.find((p) => p.type === "day").value);
        if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
            return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
        }
    } catch (_) {
        // Fallback to local calendar date if Intl fails
    }
    return Math.floor(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()) / 86400000);
}

export function getRoastIndexForDay(dayNumber, offset = 0) {
    const n = ROAST_MESSAGES.length;
    return (((dayNumber + offset) % n) + n) % n;
}

function renderRoastMessage(container, segments) {
    if (!container) return;
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
    for (const seg of segments) {
        if (seg.type === "gold") {
            const strong = document.createElement("strong");
            strong.className = "roast-gold";
            strong.textContent = seg.text;
            container.appendChild(strong);
        } else if (seg.type === "em") {
            const em = document.createElement("em");
            em.textContent = seg.text;
            container.appendChild(em);
        } else {
            container.appendChild(document.createTextNode(seg.text));
        }
    }
}

function initRoastBanner() {
    const msgEl = document.getElementById("roast-message");
    const nextBtn = document.getElementById("roast-next-btn");
    const vipBtn = document.getElementById("roast-vip-btn");
    const toastEl = document.getElementById("roast-toast");
    if (!msgEl || !nextBtn || !vipBtn || !toastEl) return;

    let activeDay = getCairoDayNumber();
    let manualOffset = 0;
    let toastTimer = null;

    const updateMessage = () => {
        const idx = getRoastIndexForDay(activeDay, manualOffset);
        renderRoastMessage(msgEl, ROAST_MESSAGES[idx]);
    };

    const checkDayRollover = () => {
        const nowDay = getCairoDayNumber();
        if (nowDay !== activeDay) {
            activeDay = nowDay;
            manualOffset = 0;
            updateMessage();
        }
    };

    const hideToast = () => {
        clearTimeout(toastTimer);
        toastTimer = null;
        toastEl.hidden = true;
    };

    const showToast = () => {
        clearTimeout(toastTimer);
        toastEl.textContent = "Just kidding! Keep your money, we don't do exam-week extortion here. Go ace your test!";
        toastEl.hidden = false;
        toastTimer = setTimeout(hideToast, 5000);
    };

    nextBtn.addEventListener("click", () => {
        manualOffset = (manualOffset + 1) % ROAST_MESSAGES.length;
        updateMessage();
    });

    vipBtn.addEventListener("click", showToast);
    toastEl.addEventListener("click", hideToast);

    setInterval(checkDayRollover, 60000);
    window.addEventListener("focus", checkDayRollover);
    window.addEventListener("pageshow", checkDayRollover);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkDayRollover();
    });

    updateMessage();
}

if (typeof document !== "undefined") {
    initRoastBanner();
}
