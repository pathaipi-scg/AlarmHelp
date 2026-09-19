"use strict";

const workspace = document.getElementById("workspace");
let timer = null;
let viewingHistory = false;
let selectedHistoryId = null;
let newestHistoryId = null;
let notifiedHistoryId = null;
let historyRows = [];
let olderCursor = null;
let historyLoaded = false;
let historyBusy = false;
let paretoMode = false;
let detailVersion = 0;
let paretoVersion = 0;
let latestBusy = false;
const idCompare = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

const text = (value) => value === null || value === undefined || value === "" ? "—" : String(value);

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
    status.className = paretoMode ? "muted hidden" : "muted";
    content.classList.remove("hidden");
    renderKnowledge(data.knowledge, alarm);
    if (data.knowledge_unavailable) status.textContent += " - Tag Knowledge is unavailable.";
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

function setPareto(active) {
    if (active) detailVersion++;
    paretoMode = active;
    paretoVersion++;
    document.getElementById("back-latest").classList.toggle("hidden", active || !viewingHistory);
    document.getElementById("pareto-panel").classList.toggle("hidden", !active);
    document.getElementById("detail-status").classList.toggle("hidden", active);
    document.getElementById("detail-content").classList.toggle("hidden", active || !document.getElementById("knowledge").children.length);
    if (active) setHistoryOpen(true);
}

function showNewAlarm(data) {
    detailVersion++;
    setPareto(false);
    viewingHistory = true; // Pin this occurrence, even if upstream later selects an older priority alarm.
    selectedHistoryId = data.alarm.history_id == null ? null : String(data.alarm.history_id);
    document.getElementById("back-latest").classList.remove("hidden");
    renderDetail(data);
    document.getElementById("detail-status").textContent = "Showing newest alarm";
    renderHistory(historyRows);
    setHistoryOpen(true);
    document.getElementById("history-scroll").scrollTop = 0;
    if (selectedHistoryId) loadHistoryDetail(selectedHistoryId);
}

async function loadLatest() {
    if (latestBusy) return;
    latestBusy = true;
    const version = detailVersion;
    try {
        const data = await fetchJson("/api/alarm-help/latest");
        // HistoryId is the activation watermark. Priority/state/value changes in
        // the upstream latest selection are not new occurrences.
        if (!viewingHistory && !paretoMode && version === detailVersion) renderDetail(data);
    } catch (error) {
        if (!viewingHistory && !paretoMode) {
            document.getElementById("detail-status").textContent = error.message;
        }
    } finally { latestBusy = false; }
}

function renderHistory(alarms) {
    const body = document.getElementById("history-body");
    const rows = (alarms || []).map((alarm) => {
        const row = document.createElement("tr");
        row.dataset.historyId = String(alarm.history_id);
        row.classList.toggle("selected", String(selectedHistoryId) === String(alarm.history_id));
        const time = document.createElement("td");
        time.textContent = displayTime(alarm.activated_at, true);
        const name = document.createElement("td");
        name.textContent = text(alarm.tag_name);
        name.title = text(alarm.tag_name);
        row.append(time, name);
        row.addEventListener("click", () => loadHistoryDetail(alarm.history_id));
        return row;
    });
    const scroller = document.getElementById("history-scroll");
    const scrollTop = scroller.scrollTop;
    const first = [...body.children].find(row => row.offsetTop >= scrollTop);
    const anchorId = first?.dataset.historyId;
    const offset = first ? first.offsetTop - scrollTop : 0;
    body.replaceChildren(...rows);
    const anchor = [...body.children].find(row => row.dataset.historyId === anchorId);
    scroller.scrollTop = anchor ? anchor.offsetTop - offset : scrollTop;
    document.getElementById("history-status").textContent = rows.length ? "" : "No alarm history";
}

function mergeHistory(alarms) {
    const merged = new Map(historyRows.map(row => [String(row.history_id), row]));
    let changed = false;
    alarms.forEach(row => {
        const key = String(row.history_id);
        if (JSON.stringify(merged.get(key)) !== JSON.stringify(row)) changed = true;
        merged.set(key, row);
    });
    if (!changed) return;
    historyRows = [...merged.values()].sort((a, b) => -idCompare(a.history_id, b.history_id));
    renderHistory(historyRows);
}

async function loadHistory(older = false) {
    if (historyBusy || (older && historyLoaded && !olderCursor)) return;
    historyBusy = true;
    const button = document.getElementById("load-older");
    button.disabled = true;
    try {
        const previousNewest = newestHistoryId;
        let cursor = older ? olderCursor : null;
        let firstPage = true;
        let refreshedNewest = previousNewest;
        let resetScroll = false;
        do {
            const data = await fetchJson(`/api/alarm-help/history?limit=50${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
            const alarms = data.alarms || [];
            if (!older && firstPage && alarms.length) {
                const newest = alarms[0];
                if (notifiedHistoryId !== null && idCompare(newest.history_id, notifiedHistoryId) > 0) {
                    showNewAlarm({has_alarm: true, alarm: newest, knowledge: null});
                    resetScroll = true;
                }
                refreshedNewest = String(newest.history_id);
                notifiedHistoryId = refreshedNewest;
            }
            if (!older && firstPage && !alarms.length && newestHistoryId === null) { refreshedNewest = "0"; notifiedHistoryId = "0"; }
            mergeHistory(alarms);
            if (resetScroll) document.getElementById("history-scroll").scrollTop = 0;
            if (older || !historyLoaded) olderCursor = data.next_cursor;
            cursor = data.next_cursor;
            firstPage = false;
            // Fill only the gap since the previous refresh; each SQL read stays bounded.
            if (older || previousNewest === null || alarms.some(row => idCompare(row.history_id, previousNewest) <= 0)) break;
        } while (cursor);
        if (!older) newestHistoryId = refreshedNewest;
        historyLoaded = true;
        button.textContent = olderCursor ? "Load older alarms" : "End of history";
    } catch (error) {
        document.getElementById("history-status").textContent = error.message;
        button.textContent = "Retry loading history";
    } finally { historyBusy = false; button.disabled = historyLoaded && !olderCursor; }
}

async function loadHistoryDetail(historyId) {
    if (paretoMode) return; // Keep the alarm that Back to Alarm must restore.
    const version = ++detailVersion;
    try {
        const data = await fetchJson(`/api/alarm-help/history/${encodeURIComponent(historyId)}`);
        if (version !== detailVersion) return;
        viewingHistory = true;
        selectedHistoryId = String(historyId);
        document.getElementById("back-latest").classList.remove("hidden");
        renderHistory(historyRows);
        renderDetail(data);
        if (paretoMode) document.getElementById("detail-content").classList.add("hidden");
    } catch (error) {
        if (version === detailVersion) document.getElementById("detail-status").textContent = error.message;
    }
}

function svgElement(name, attributes, label) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    if (label !== undefined) element.textContent = label;
    return element;
}

function renderPareto(data) {
    const host = document.getElementById("pareto-chart");
    const body = document.getElementById("pareto-body");
    host.replaceChildren(); body.replaceChildren();
    document.getElementById("pareto-status").textContent = data.total ? `${data.total} occurrences. Bars: count; yellow line: cumulative %. Chart shows first 30 alarms; table includes all.` : "No alarm occurrences in this time frame.";
    if (!data.total) return;
    const alarms = data.alarms.slice(0, 30);
    const width = Math.max(640, alarms.length * 100 + 120);
    const chart = svgElement("svg", {width, height: 370, role: "img", "aria-label": "Alarm occurrence counts and cumulative percentage"});
    const max = alarms[0].count;
    const step = (width - 120) / alarms.length;
    for (let i = 0; i <= 4; i++) {
        const y = 260 - i * 55;
        chart.append(svgElement("line", {x1: 55, x2: width - 55, y1: y, y2: y, stroke: "#334754"}));
        chart.append(svgElement("text", {x: 50, y: y + 4, fill: "#a9bac4", "text-anchor": "end"}, (max * i / 4).toLocaleString()));
        chart.append(svgElement("text", {x: width - 48, y: y + 4, fill: "#ffd166"}, `${i * 25}%`));
    }
    chart.append(svgElement("text", {x: 55, y: 20, fill: "#f2f6f8"}, "Occurrence Count"));
    chart.append(svgElement("text", {x: width - 55, y: 20, fill: "#ffd166", "text-anchor": "end"}, "Cumulative %"));
    const points = [];
    alarms.forEach((alarm, i) => {
        const x = 55 + step * (i + .5);
        const height = 220 * alarm.count / max;
        const bar = svgElement("rect", {x: x - step * .3, y: 260 - height, width: step * .6, height, fill: "#43b8dc"});
        bar.append(svgElement("title", {}, `${alarm.kepware_path}: ${alarm.count}`));
        chart.append(bar);
        chart.append(svgElement("text", {x, y: 252 - height, fill: "#f2f6f8", "text-anchor": "middle"}, alarm.count));
        chart.append(svgElement("text", {x, y: 280, fill: "#f2f6f8", transform: `rotate(30 ${x} 280)`}, alarm.tag_name.length > 20 ? alarm.tag_name.slice(0, 19) + "..." : alarm.tag_name));
        points.push(`${x},${260 - 2.2 * alarm.cumulative_percentage}`);
    });
    chart.append(svgElement("polyline", {points: points.join(" "), fill: "none", stroke: "#ffd166", "stroke-width": 2}));
    points.forEach(point => { const [cx, cy] = point.split(","); chart.append(svgElement("circle", {cx, cy, r: 3, fill: "#ffd166"})); });
    host.append(chart);
    data.alarms.forEach(alarm => {
        const row = document.createElement("tr");
        [alarm.tag_name, alarm.count, `${alarm.percentage.toFixed(2)}%`, `${alarm.cumulative_percentage.toFixed(2)}%`].forEach(value => {
            const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
        });
        const path = document.createElement("small"); path.textContent = `${alarm.kepware_path} (Alarm ${alarm.alarm_id})`;
        row.children[0].append(path); body.append(row);
    });
}

async function loadPareto() {
    const version = ++paretoVersion;
    const select = document.getElementById("pareto-window");
    document.getElementById("pareto-title").textContent = `Alarm Pareto - Last ${select.options[select.selectedIndex].text}`;
    document.getElementById("pareto-status").textContent = "Loading Pareto...";
    document.getElementById("pareto-chart").replaceChildren();
    document.getElementById("pareto-body").replaceChildren();
    try {
        const data = await fetchJson(`/api/alarm-help/pareto?window=${select.value}`);
        if (paretoMode && version === paretoVersion) renderPareto(data);
    } catch (error) {
        if (paretoMode && version === paretoVersion) document.getElementById("pareto-status").textContent = error.message;
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
document.getElementById("refresh-history").addEventListener("click", () => loadHistory());
document.getElementById("refresh-latest").addEventListener("click", loadLatest);
document.getElementById("auto-refresh").addEventListener("change", startPolling);
document.getElementById("back-latest").addEventListener("click", async () => {
    detailVersion++;
    setPareto(false);
    viewingHistory = false;
    selectedHistoryId = null;
    document.getElementById("back-latest").classList.add("hidden");
    document.getElementById("newer-alarm").classList.add("hidden");
    document.querySelectorAll("#history-body tr").forEach((row) => row.classList.remove("selected"));
    await loadLatest();
});

document.getElementById("load-older").addEventListener("click", () => loadHistory(true));
document.getElementById("history-scroll").addEventListener("scroll", event => {
    const target = event.target;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 180) loadHistory(true);
});
document.getElementById("open-pareto").addEventListener("click", () => { setPareto(true); loadPareto(); });
document.getElementById("back-alarm").addEventListener("click", () => setPareto(false));
document.getElementById("pareto-window").addEventListener("change", loadPareto);
refreshAll();
startPolling();
