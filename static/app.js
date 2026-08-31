"use strict";

const workspace = document.getElementById("workspace");
let timer = null;
let viewingHistory = false;
let selectedHistoryId = null;
let latestKey = null;

const text = (value) => value === null || value === undefined || value === "" ? "—" : String(value);
const eventKey = (alarm) => alarm ? [alarm.history_id, alarm.alarm_id, alarm.activated_at, alarm.state, alarm.value].join("|") : null;

function displayTime(value, timeOnly = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return text(value);
    return timeOnly ? date.toLocaleTimeString([], { hour12: false }) : date.toLocaleString([], { hour12: false });
}

function setHistoryOpen(open) {
    workspace.classList.toggle("history-collapsed", !open);
    document.getElementById("close-history").setAttribute("aria-expanded", String(open));
    document.getElementById("open-history").setAttribute("aria-expanded", String(open));
    document.getElementById("open-history").classList.toggle("hidden", open);
}

function imageUrl(url) {
    if (!url) return "";
    try {
        const parsed = new URL(url, window.location.origin);
        return parsed.pathname === "/api/tag-knowledge/attachment" ? `${parsed.pathname}${parsed.search}` : "";
    } catch (_error) { return ""; }
}

function renderCompactMetadata(alarm) {
    const metadata = document.createElement("dl");
    metadata.className = "compact-metadata";
    [
        ["Time", displayTime(alarm.activated_at)],
        ["Kepware Path", text(alarm.kepware_path)],
        ["Value", text(alarm.value)],
    ].forEach(([label, value]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        row.append(term, detail);
        metadata.appendChild(row);
    });
    return metadata;
}

function renderKnowledge(knowledge, alarm) {
    const host = document.getElementById("knowledge");
    host.replaceChildren();
    let hasKnowledge = false;
    const sections = [
        ["description", "Description / Meaning"],
        ["how_to_check", "How to Check / Troubleshooting"],
        ["corrective_action", "Corrective Action"],
        ["safety_warning", "Safety / Warning"],
        ["additional_notes", "Additional Notes"],
    ];
    sections.forEach(([key, title]) => {
        const content = knowledge?.sections?.[key] || {};
        const images = Array.isArray(content.images) ? content.images : [];
        if (content.text || images.length) {
            hasKnowledge = true;
            const section = document.createElement("section");
            section.className = `knowledge-section${key === "safety_warning" ? " safety" : ""}`;
            const heading = document.createElement("h3");
            heading.textContent = title;
            section.appendChild(heading);
            if (content.text) {
                const paragraph = document.createElement("p");
                paragraph.className = "knowledge-text";
                paragraph.textContent = content.text;
                section.appendChild(paragraph);
            }
            if (images.length) {
                const gallery = document.createElement("div");
                gallery.className = "knowledge-images";
                images.forEach((item) => {
                    const source = imageUrl(item.url);
                    if (!source) return;
                    const figure = document.createElement("figure");
                    const image = document.createElement("img");
                    image.src = source;
                    image.alt = item.caption || title;
                    image.loading = "lazy";
                    figure.appendChild(image);
                    if (item.caption) {
                        const caption = document.createElement("figcaption");
                        caption.textContent = item.caption;
                        figure.appendChild(caption);
                    }
                    gallery.appendChild(figure);
                });
                section.appendChild(gallery);
            }
            host.appendChild(section);
        }
        if (key === "description") host.appendChild(renderCompactMetadata(alarm));
    });
    if (!hasKnowledge) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No troubleshooting knowledge is available for this tag.";
        host.appendChild(empty);
    }
}

function renderDetail(data) {
    const status = document.getElementById("detail-status");
    const content = document.getElementById("detail-content");
    if (!data?.has_alarm || !data.alarm) {
        status.textContent = "No alarm event available";
        status.className = "muted";
        content.classList.add("hidden");
        return;
    }
    const alarm = data.alarm;
    status.textContent = viewingHistory ? "Viewing selected history event" : "Showing latest alarm";
    status.className = "muted";
    content.classList.remove("hidden");
    renderKnowledge(data.knowledge, alarm);
}

async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Alarm data is unavailable.");
    return data;
}

async function loadActivity() {
    try {
        const data = await fetchJson("/api/alarm-help/activity");
        document.getElementById("activity-time").textContent = data.has_activity ? displayTime(data.event_time, true) : "—";
        document.getElementById("activity-name").textContent = data.has_activity ? text(data.tag_name) : "No recent alarm activity";
        document.getElementById("activity-state").textContent = data.has_activity ? text(data.state) : "—";
    } catch (error) {
        document.getElementById("activity-name").textContent = error.message;
        document.getElementById("activity-state").textContent = "Unavailable";
    }
}

async function loadLatest() {
    try {
        const data = await fetchJson("/api/alarm-help/latest");
        const nextKey = eventKey(data.alarm);
        if (viewingHistory) {
            if (nextKey && latestKey && nextKey !== latestKey) document.getElementById("newer-alarm").classList.remove("hidden");
        } else {
            renderDetail(data);
        }
        latestKey = nextKey;
    } catch (error) {
        if (!viewingHistory) {
            const status = document.getElementById("detail-status");
            status.textContent = error.message;
            status.className = "error";
        }
    }
}

function renderHistory(alarms) {
    const body = document.getElementById("history-body");
    const rows = (alarms || []).map((alarm) => {
        const row = document.createElement("tr");
        row.dataset.historyId = String(alarm.history_id);
        row.classList.toggle("selected", Number(selectedHistoryId) === Number(alarm.history_id));
        const time = document.createElement("td");
        time.textContent = displayTime(alarm.activated_at, true);
        const name = document.createElement("td");
        name.textContent = text(alarm.tag_name);
        name.title = text(alarm.tag_name);
        row.append(time, name);
        row.addEventListener("click", () => loadHistoryDetail(alarm.history_id));
        return row;
    });
    body.replaceChildren(...rows);
    document.getElementById("history-status").textContent = rows.length ? "" : "No alarm history";
}

async function loadHistory() {
    try {
        const data = await fetchJson("/api/alarm-help/recent?limit=5");
        renderHistory(data.alarms);
    } catch (error) {
        const status = document.getElementById("history-status");
        status.textContent = error.message;
        status.className = "error";
    }
}

async function loadHistoryDetail(historyId) {
    try {
        const data = await fetchJson(`/api/alarm-help/history/${encodeURIComponent(historyId)}`);
        viewingHistory = true;
        selectedHistoryId = Number(historyId);
        document.getElementById("back-latest").classList.remove("hidden");
        document.querySelectorAll("#history-body tr").forEach((row) => row.classList.toggle("selected", Number(row.dataset.historyId) === Number(historyId)));
        renderDetail(data);
    } catch (error) {
        const status = document.getElementById("detail-status");
        status.textContent = error.message;
        status.className = "error";
    }
}

async function refreshAll() { await Promise.all([loadActivity(), loadLatest(), loadHistory()]); }
function startPolling() {
    if (timer !== null) window.clearInterval(timer);
    const seconds = Number(document.getElementById("auto-refresh").value);
    if (seconds > 0) timer = window.setInterval(refreshAll, seconds * 1000);
}

document.getElementById("close-history").addEventListener("click", () => setHistoryOpen(false));
document.getElementById("open-history").addEventListener("click", () => setHistoryOpen(true));
document.getElementById("refresh-history").addEventListener("click", loadHistory);
document.getElementById("refresh-latest").addEventListener("click", loadLatest);
document.getElementById("auto-refresh").addEventListener("change", startPolling);
document.getElementById("back-latest").addEventListener("click", async () => {
    viewingHistory = false;
    selectedHistoryId = null;
    document.getElementById("back-latest").classList.add("hidden");
    document.getElementById("newer-alarm").classList.add("hidden");
    document.querySelectorAll("#history-body tr").forEach((row) => row.classList.remove("selected"));
    await loadLatest();
});

refreshAll();
startPolling();
