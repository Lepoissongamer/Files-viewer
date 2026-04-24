/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, createRoot, DraftType, React, SelectedChannelStore, showToast, Toasts, Tooltip, UploadHandler, useEffect, useRef, useState } from "@webpack/common";
import type { Root } from "react-dom/client";

const settings = definePluginSettings({
    enableShikiColoring: {
        type: OptionType.BOOLEAN,
        description: "Enable VS code theme",
        default: true
    },
    enablePerformanceMode: {
        type: OptionType.BOOLEAN,
        description: "Enable performence mode",
        default: true
    },
    autoPerformanceMode: {
        type: OptionType.BOOLEAN,
        description: "Enable auto performance mode. If not enable perfomance gonna be always on.)",
        default: true,
        disabled: () => !settings.store.enablePerformanceMode
    },
    autoPerformanceCharThreshold: {
        type: OptionType.NUMBER,
        description: "Letter max for enable performance mode",
        default: 250_000,
        disabled: () => !settings.store.enablePerformanceMode || !settings.store.autoPerformanceMode,
        isValid: value => value >= 1 || "letter gonna be at least >= 1"
    },
    autoPerformanceLineThreshold: {
        type: OptionType.NUMBER,
        description: "Lignes max for enable perfomance mode",
        default: 8_000,
        disabled: () => !settings.store.enablePerformanceMode || !settings.store.autoPerformanceMode,
        isValid: value => value >= 1 || "lignes gonna be at least >= 1"
    },
    forceShikiInPerformanceMode: {
        type: OptionType.BOOLEAN,
        description: "Use VS theme even in perfomence mode (shiki)",
        default: false,
        disabled: () => !settings.store.enablePerformanceMode || !settings.store.enableShikiColoring
    },
    allowManualPerformanceToggleInViewer: {
        type: OptionType.BOOLEAN,
        description: "Enable on/off toggle in files viewer",
        default: true,
        disabled: () => !settings.store.enablePerformanceMode
    }
});

function isSupportedFilename(filename: string) {
    const name = filename.toLowerCase();
    return (
        name.endsWith(".log")
        || name.endsWith(".txt")
        || name.endsWith(".ini")
        || name.endsWith(".cfg")
        || name.endsWith(".json")
        || name.endsWith(".xml")
    );
}

function inferLanguage(filename: string, rawText: string) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";

    const langMap: Record<string, string> = {
        c: "c",
        cc: "cpp",
        cfg: "ini",
        cpp: "cpp",
        cs: "csharp",
        css: "css",
        go: "go",
        h: "c",
        hpp: "cpp",
        html: "html",
        ini: "ini",
        java: "java",
        js: "javascript",
        json: "json",
        kt: "kotlin",
        log: "log",
        lua: "lua",
        md: "markdown",
        php: "php",
        ps1: "powershell",
        py: "python",
        rb: "ruby",
        rs: "rust",
        sh: "bash",
        sql: "sql",
        toml: "toml",
        ts: "typescript",
        txt: "log",
        xml: "xml",
        yaml: "yaml",
        yml: "yaml",
    };

    const fromExt = langMap[ext];
    if (fromExt && fromExt !== "text") return fromExt;

    const trimmed = rawText.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            JSON.parse(trimmed);
            return "json";
        } catch { }
    }

    if (trimmed.startsWith("<") && trimmed.includes(">")) return "xml";
    if (rawText.includes("Traceback (most recent call last):")) return "python";

    return fromExt ?? "text";
}

function withLineNumbers(rawText: string, lineCount: number) {
    const width = Math.max(3, lineCount.toString().length);
    const lines = rawText.split("\n");
    // Avoid adding an artificial numbered empty line when the file ends with a trailing newline.
    if (lines.length > 1 && lines[lines.length - 1] === "") {
        lines.pop();
    }

    return lines
        .map((line, idx) => `${(idx + 1).toString().padStart(width, " ")} | ${line}`)
        .join("\n");
}

function getLineCount(rawText: string) {
    return rawText.split("\n").length;
}

function getTextMimeType(filename: string) {
    const name = filename.toLowerCase();

    if (name.endsWith(".json")) return "application/json";
    if (name.endsWith(".xml")) return "application/xml";
    if (name.endsWith(".log") || name.endsWith(".txt") || name.endsWith(".ini") || name.endsWith(".cfg")) {
        return "text/plain";
    }

    return "text/plain";
}

function attachFileToCurrentChannel(filename: string, fileText: string) {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;

    if (!channel) {
        showToast("Impossible d'ajouter la pièce jointe: aucun salon actif.", Toasts.Type.FAILURE);
        return false;
    }

    const uploadFile = new File([fileText], filename || "document.txt", { type: getTextMimeType(filename) });

    try {
        UploadHandler.promptToUpload([uploadFile], channel, DraftType.ChannelMessage);
        showToast("Fichier ajouté comme pièce jointe.", Toasts.Type.SUCCESS);
        return true;
    } catch (err) {
        console.error("[FullLogViewer] Failed to attach edited file", err);
        showToast("Impossible d'ajouter la pièce jointe.", Toasts.Type.FAILURE);
        return false;
    }
}

function clearSearchHighlights(root: HTMLElement) {
    const marks = root.querySelectorAll("mark.vc-log-search-hit");
    marks.forEach(mark => {
        const text = document.createTextNode(mark.textContent ?? "");
        mark.replaceWith(text);
    });

    root.normalize();
}

function applySearchHighlight(root: HTMLElement, query: string, maxMatches = Number.POSITIVE_INFINITY) {
    clearSearchHighlights(root);
    if (!query) return [] as HTMLElement[];

    const lowerQuery = query.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const marks: HTMLElement[] = [];

    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        nodes.push(node);
    }

    for (const textNode of nodes) {
        if (marks.length >= maxMatches) break;
        const source = textNode.nodeValue ?? "";
        const lower = source.toLowerCase();
        let start = 0;
        let idx = lower.indexOf(lowerQuery, start);
        if (idx === -1) continue;

        const frag = document.createDocumentFragment();
        while (idx !== -1) {
            if (marks.length >= maxMatches) break;
            if (idx > start) frag.appendChild(document.createTextNode(source.slice(start, idx)));
            const mark = document.createElement("mark");
            mark.className = "vc-log-search-hit";
            mark.style.background = "#f7cc4a";
            mark.style.color = "#1a1a1a";
            mark.textContent = source.slice(idx, idx + query.length);
            frag.appendChild(mark);
            marks.push(mark);

            start = idx + query.length;
            idx = lower.indexOf(lowerQuery, start);
        }

        if (start < source.length) frag.appendChild(document.createTextNode(source.slice(start)));
        textNode.replaceWith(frag);
    }

    return marks;
}

function getSearchRoots(root: HTMLElement) {
    const shikiCodeCells = root.querySelectorAll<HTMLElement>(".vc-shiki-table-row > .vc-shiki-table-cell:nth-child(2)");
    return shikiCodeCells.length ? Array.from(shikiCodeCells) : [root];
}

type SearchSegment = { node: Text; start: number; end: number; };
type SearchIndex = {
    lowerText: string;
    segments: SearchSegment[];
};

function buildSearchIndex(root: HTMLElement): SearchIndex {
    const segments: SearchSegment[] = [];
    let combinedText = "";

    for (const searchRoot of getSearchRoots(root)) {
        if (combinedText) combinedText += "\n";

        const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode as Text;
            const value = node.nodeValue ?? "";
            if (!value) continue;

            const start = combinedText.length;
            combinedText += value;
            segments.push({ node, start, end: combinedText.length });
        }
    }

    return {
        lowerText: combinedText.toLowerCase(),
        segments
    };
}

function findSegmentForOffset(segments: SearchSegment[], offset: number) {
    let low = 0;
    let high = segments.length - 1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        const segment = segments[mid];

        if (offset < segment.start) {
            high = mid - 1;
        } else if (offset > segment.end) {
            low = mid + 1;
        } else {
            return segment;
        }
    }

    return null;
}

function findSearchRanges(searchIndex: SearchIndex, query: string, maxMatches = Number.POSITIVE_INFINITY) {
    if (!query) return [] as Range[];

    const lowerQuery = query.toLowerCase();
    const ranges: Range[] = [];
    let start = 0;
    let idx = searchIndex.lowerText.indexOf(lowerQuery, start);

    while (idx !== -1 && ranges.length < maxMatches) {
        const end = idx + query.length;
        const startSegment = findSegmentForOffset(searchIndex.segments, idx);
        const endSegment = findSegmentForOffset(searchIndex.segments, end);

        if (startSegment && endSegment) {
            const range = document.createRange();
            range.setStart(startSegment.node, idx - startSegment.start);
            range.setEnd(endSegment.node, end - endSegment.start);
            ranges.push(range);
        }

        start = end;
        idx = searchIndex.lowerText.indexOf(lowerQuery, start);
    }

    return ranges;
}

function canUseCssHighlights() {
    return Boolean((CSS as unknown as { highlights?: Map<string, unknown>; }).highlights && (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown; }).Highlight);
}

function clearCssSearchHighlights(hitName: string, activeName: string) {
    const { highlights } = CSS as unknown as { highlights?: Map<string, unknown>; };
    highlights?.delete(hitName);
    highlights?.delete(activeName);
}

function setCssSearchHighlights(hitName: string, activeName: string, ranges: Range[], activeIndex: number) {
    const { highlights } = CSS as unknown as { highlights?: Map<string, unknown>; };
    const { Highlight: HighlightCtor } = window as unknown as { Highlight?: new (...ranges: Range[]) => unknown; };
    if (!highlights || !HighlightCtor) return false;

    const safeActiveIndex = activeIndex >= 0 && activeIndex < ranges.length ? activeIndex : -1;
    const regularRanges = safeActiveIndex === -1
        ? ranges
        : ranges.filter((_, i) => i !== safeActiveIndex);
    const activeRanges = safeActiveIndex === -1 ? [] : [ranges[safeActiveIndex]];

    highlights.set(hitName, new HighlightCtor(...regularRanges));
    highlights.set(activeName, new HighlightCtor(...activeRanges));
    return true;
}

function openLogModal(
    filename: string,
    rawText: string,
    manualPerformanceMode: boolean | null = null,
    onManualPerformanceModeChange?: (value: boolean | null) => void
) {
    const {
        allowManualPerformanceToggleInViewer,
        autoPerformanceCharThreshold: autoCharThreshold,
        autoPerformanceLineThreshold: autoLineThreshold,
        autoPerformanceMode: autoPerfEnabled,
        enablePerformanceMode: performanceModeEnabled,
        enableShikiColoring: showShiki,
        forceShikiInPerformanceMode
    } = settings.store;

    const autoPerformanceMode = performanceModeEnabled && autoPerfEnabled;
    let currentText = rawText;
    let isEditing = false;
    let editor: HTMLTextAreaElement | null = null;
    let editorHighlightLayer: HTMLElement | null = null;
    let renderRoot: Root | null = null;
    let searchableRoot: HTMLElement | null = null;
    let searchIndex: SearchIndex | null = null;
    let currentMatches: HTMLElement[] = [];
    let currentRangeMatches: Range[] = [];
    let editorMatches: Array<{ start: number; end: number; }> = [];
    let activeMatchIndex = -1;
    let searchDebounce: number | null = null;
    let useRangeSearch = false;
    let didCleanup = false;
    const shikiCharLimit = 120_000;
    const highlightId = Math.random().toString(36).slice(2);
    const cssHitHighlightName = `vc-log-search-hit-${highlightId}`;
    const cssActiveHighlightName = `vc-log-search-active-${highlightId}`;

    const bgPrimary = "var(--background-primary, #1e1f22)";
    const bgSecondary = "var(--background-secondary, #2b2d31)";
    const bgTertiary = "var(--background-tertiary, #313338)";
    const borderColor = "var(--background-modifier-accent, #4e5058)";
    const textNormal = "var(--text-normal, #dbdee1)";
    const textMuted = "var(--text-muted, #b5bac1)";
    const buttonSecondary = "var(--button-secondary-background, #4e5058)";
    const buttonDanger = "var(--button-danger-background, #da373c)";
    const buttonSuccess = "var(--button-positive-background, #248046)";
    const initialLineCount = getLineCount(currentText);

    const existing = document.getElementById("vc-full-log-viewer-modal");
    if (existing) {
        (existing as { vcCleanup?: () => void; }).vcCleanup?.();
        existing.remove();
    }

    const cssHighlightStyle = document.createElement("style");
    cssHighlightStyle.textContent = `
::highlight(${cssHitHighlightName}) {
    background-color: #f7cc4a;
    color: #1a1a1a;
}
::highlight(${cssActiveHighlightName}) {
    background-color: #ff9800;
    color: #111;
}
`;
    document.head.appendChild(cssHighlightStyle);

    const overlay = document.createElement("div");
    overlay.id = "vc-full-log-viewer-modal";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,0.75)";
    overlay.style.zIndex = "999999";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";

    const box = document.createElement("div");
    box.style.width = "min(95vw, 1500px)";
    box.style.height = "min(92vh, 1000px)";
    box.style.background = bgPrimary;
    box.style.border = `1px solid ${borderColor}`;
    box.style.borderRadius = "12px";
    box.style.display = "flex";
    box.style.flexDirection = "column";
    box.style.overflow = "hidden";
    box.style.boxShadow = (
        performanceModeEnabled && (
            autoPerformanceMode
                ? currentText.length > autoCharThreshold || initialLineCount > autoLineThreshold
                : true
        ) && manualPerformanceMode !== false
    ) ? "none" : "0 20px 60px rgba(0,0,0,0.45)";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.gap = "8px";
    header.style.alignItems = "center";
    header.style.padding = "12px";
    header.style.borderBottom = `1px solid ${borderColor}`;
    header.style.background = bgSecondary;

    const title = document.createElement("div");
    title.textContent = filename;
    title.style.fontWeight = "700";
    title.style.flex = "1";

    const search = document.createElement("input");
    search.type = "text";
    search.placeholder = "Search...";
    search.style.width = "260px";
    search.style.padding = "8px 10px";
    search.style.borderRadius = "8px";
    search.style.border = `1px solid ${borderColor}`;
    search.style.background = bgTertiary;
    search.style.color = textNormal;
    search.style.outline = "none";
    search.style.minWidth = "220px";

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "▲";
    prevBtn.title = "Back";
    prevBtn.style.padding = "8px 10px";
    prevBtn.style.borderRadius = "8px";
    prevBtn.style.border = "none";
    prevBtn.style.cursor = "pointer";
    prevBtn.style.background = buttonSecondary;
    prevBtn.style.color = textNormal;
    prevBtn.disabled = true;

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▼";
    nextBtn.title = "Next";
    nextBtn.style.padding = "8px 10px";
    nextBtn.style.borderRadius = "8px";
    nextBtn.style.border = "none";
    nextBtn.style.cursor = "pointer";
    nextBtn.style.background = buttonSecondary;
    nextBtn.style.color = textNormal;
    nextBtn.disabled = true;

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy all";
    copyBtn.style.padding = "8px 12px";
    copyBtn.style.borderRadius = "8px";
    copyBtn.style.border = "none";
    copyBtn.style.cursor = "pointer";
    copyBtn.style.background = buttonSecondary;
    copyBtn.style.color = textNormal;
    copyBtn.onclick = async () => {
        await copyWithToast(isEditing ? (editor?.value ?? currentText) : currentText, "File copied to clipboard!");
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit file";
    editBtn.style.padding = "8px 12px";
    editBtn.style.borderRadius = "8px";
    editBtn.style.border = "none";
    editBtn.style.cursor = "pointer";
    editBtn.style.background = buttonSecondary;
    editBtn.style.color = textNormal;

    const closeEditBtn = document.createElement("button");
    closeEditBtn.textContent = "Close edit";
    closeEditBtn.title = "Close the edit windows without editing";
    closeEditBtn.style.padding = "8px 12px";
    closeEditBtn.style.borderRadius = "8px";
    closeEditBtn.style.border = "none";
    closeEditBtn.style.cursor = "pointer";
    closeEditBtn.style.background = buttonDanger;
    closeEditBtn.style.color = textNormal;
    closeEditBtn.style.display = "none";

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "X";
    closeBtn.title = "Close";
    closeBtn.style.width = "36px";
    closeBtn.style.height = "32px";
    closeBtn.style.padding = "0";
    closeBtn.style.borderRadius = "6px";
    closeBtn.style.border = "none";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.background = "transparent";
    closeBtn.style.color = textNormal;
    closeBtn.style.fontSize = "22px";
    closeBtn.style.lineHeight = "32px";
    closeBtn.style.display = "inline-flex";
    closeBtn.style.alignItems = "center";
    closeBtn.style.justifyContent = "center";
    closeBtn.onmouseenter = () => {
        closeBtn.style.background = buttonDanger;
        closeBtn.style.color = "white";
    };
    closeBtn.onmouseleave = () => {
        closeBtn.style.background = "transparent";
        closeBtn.style.color = textNormal;
    };

    const perfToggleBtn = document.createElement("button");
    perfToggleBtn.textContent = "Perf: OFF";
    perfToggleBtn.style.padding = "8px 12px";
    perfToggleBtn.style.borderRadius = "8px";
    perfToggleBtn.style.border = "none";
    perfToggleBtn.style.cursor = "pointer";
    perfToggleBtn.style.background = buttonSecondary;
    perfToggleBtn.style.color = textNormal;

    const stats = document.createElement("div");
    stats.style.padding = "8px 12px";
    stats.style.fontSize = "12px";
    stats.style.color = textMuted;
    stats.style.borderBottom = `1px solid ${borderColor}`;
    stats.textContent = "";

    const content = document.createElement("div");
    content.style.flex = "1";
    content.style.overflow = "auto";
    content.style.padding = "14px";
    content.style.background = bgPrimary;
    content.style.userSelect = "text";
    content.style.setProperty("-webkit-user-select", "text");
    content.style.cursor = "text";

    const scrollEditorToOffset = (offset: number) => {
        if (!editor) return;

        const beforeMatch = editor.value.slice(0, offset);
        const lineCountBeforeMatch = beforeMatch.split("\n").length - 1;
        const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 17.4;
        editor.scrollTop = Math.max(0, (lineCountBeforeMatch * lineHeight) - (editor.clientHeight / 2));
    };

    const focusMatch = (index: number, focusEditor = true) => {
        const matchCount = isEditing ? editorMatches.length : useRangeSearch ? currentRangeMatches.length : currentMatches.length;
        if (!matchCount) return;
        const safeIndex = ((index % matchCount) + matchCount) % matchCount;
        activeMatchIndex = safeIndex;

        if (isEditing && editor) {
            const match = editorMatches[safeIndex];
            if (focusEditor) editor.focus();
            editor.setSelectionRange(match.start, match.start);
            scrollEditorToOffset(match.start);
            paintEditorHighlights(editor.value, search.value.trim(), true);
            return;
        }

        if (useRangeSearch) {
            const range = currentRangeMatches[safeIndex];
            if (canUseCssHighlights()) {
                setCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName, currentRangeMatches, safeIndex);
            } else {
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            }
            range.startContainer.parentElement?.scrollIntoView({ behavior: "auto", block: "center" });
            return;
        }

        currentMatches.forEach((m, i) => {
            if (i === safeIndex) {
                m.style.background = "#ff9800";
                m.style.color = "#111";
            } else {
                m.style.background = "#f7cc4a";
                m.style.color = "#1a1a1a";
            }
        });

        currentMatches[safeIndex]?.scrollIntoView({ behavior: "auto", block: "center" });
    };

    const getWorkingText = () => isEditing ? (editor?.value ?? currentText) : currentText;

    const updateEditorMatches = (text: string) => {
        editorMatches = [];

        const { maxHighlightedMatches, minSearchLength } = getPerformanceState(text);
        const query = search.value.trim();
        const shouldSearch = query.length >= minSearchLength;

        if (shouldSearch) {
            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            let start = 0;
            let idx = lowerText.indexOf(lowerQuery, start);

            while (idx !== -1 && editorMatches.length < maxHighlightedMatches) {
                editorMatches.push({ start: idx, end: idx + query.length });
                start = idx + query.length;
                idx = lowerText.indexOf(lowerQuery, start);
            }
        }

        if (editorMatches.length > 0) {
            const selectionStart = editor?.selectionStart ?? 0;
            const currentIndex = editorMatches.findIndex(match => selectionStart >= match.start && selectionStart <= match.end);
            activeMatchIndex = currentIndex === -1 ? 0 : currentIndex;
        } else {
            activeMatchIndex = -1;
        }

        return { query, shouldSearch };
    };

    const paintEditorHighlights = (text: string, query: string, shouldSearch: boolean) => {
        if (!editorHighlightLayer) return;

        editorHighlightLayer.replaceChildren();

        if (!shouldSearch || !query || editorMatches.length === 0) {
            editorHighlightLayer.textContent = text || " ";
            return;
        }

        let cursor = 0;
        for (let i = 0; i < editorMatches.length; i++) {
            const match = editorMatches[i];
            if (match.start > cursor) {
                editorHighlightLayer.appendChild(document.createTextNode(text.slice(cursor, match.start)));
            }

            const span = document.createElement("span");
            span.textContent = text.slice(match.start, match.end);
            span.style.background = i === activeMatchIndex ? "#ff9800" : "#f7cc4a";
            span.style.color = "#1a1a1a";
            editorHighlightLayer.appendChild(span);
            cursor = match.end;
        }

        if (cursor < text.length) {
            editorHighlightLayer.appendChild(document.createTextNode(text.slice(cursor)));
        }

        if (text.endsWith("\n")) {
            editorHighlightLayer.appendChild(document.createTextNode(" "));
        }
    };

    const getPerformanceState = (text: string) => {
        const lineCount = getLineCount(text);
        const autoDetectedPerformanceMode = performanceModeEnabled && (
            autoPerformanceMode
                ? text.length > autoCharThreshold || lineCount > autoLineThreshold
                : true
        );
        const isPerformanceMode = performanceModeEnabled && (manualPerformanceMode ?? autoDetectedPerformanceMode);
        const useLowGpuMode = isPerformanceMode;
        const maxHighlightedMatches = isPerformanceMode ? 250 : 2_500;
        const minSearchLength = isPerformanceMode ? 2 : 1;

        return {
            isPerformanceMode,
            lineCount,
            maxHighlightedMatches,
            minSearchLength,
            useLowGpuMode
        };
    };

    const updateButtons = () => {
        editBtn.textContent = isEditing ? "Insert files" : "Edit file";
        editBtn.style.background = isEditing ? buttonSuccess : buttonSecondary;
        editBtn.title = isEditing ? "Insert the file in the chat box and close" : "Edit file";
        closeEditBtn.style.display = isEditing ? "inline-block" : "none";
        search.disabled = false;
        const query = search.value.trim();
        const { minSearchLength } = getPerformanceState(getWorkingText());
        const isSearchActive = query.length >= minSearchLength;
        const matchCount = isEditing ? editorMatches.length : useRangeSearch ? currentRangeMatches.length : currentMatches.length;
        prevBtn.style.display = isSearchActive ? "inline-block" : "none";
        nextBtn.style.display = isSearchActive ? "inline-block" : "none";
        prevBtn.disabled = matchCount === 0;
        nextBtn.disabled = matchCount === 0;

        const { isPerformanceMode } = getPerformanceState(getWorkingText());
        perfToggleBtn.textContent = isPerformanceMode ? "Perf: ON" : "Perf: OFF";
        perfToggleBtn.style.display = isEditing ? "none" : "inline-block";
    };

    const updateStats = () => {
        const text = getWorkingText();
        const {
            isPerformanceMode,
            lineCount,
            maxHighlightedMatches,
            minSearchLength,
            useLowGpuMode
        } = getPerformanceState(text);

        const query = search.value.trim();
        const shouldSearch = query.length >= minSearchLength;
        const matchCount = isEditing ? editorMatches.length : useRangeSearch ? currentRangeMatches.length : currentMatches.length;
        const matchPart = shouldSearch
            ? ` • ${matchCount.toLocaleString()} result${matchCount ? ` • ${activeMatchIndex + 1}/${matchCount}` : ""}`
            : "";
        const perfPart = isPerformanceMode
            ? ` • perf mode (${manualPerformanceMode == null ? (autoPerformanceMode ? "auto" : "manuel-global") : "manuel-viewer"}, search >= ${minSearchLength} chars, max ${maxHighlightedMatches.toLocaleString()} highlights)`
            : "";
        const gpuPart = useLowGpuMode ? " • low-gpu mode" : "";
        const editPart = isEditing ? " • editing" : "";

        stats.textContent = `${text.length.toLocaleString()} character • ${lineCount.toLocaleString()} lignes${matchPart}${perfPart}${gpuPart}${editPart}`;
        updateButtons();
    };

    const renderViewer = () => {
        const text = currentText;
        const { isPerformanceMode } = getPerformanceState(text);
        const canUseShikiInPerf = !isPerformanceMode || forceShikiInPerformanceMode;
        const shikiPlugin = Vencord?.Plugins?.plugins?.ShikiCodeblocks as { renderHighlighter?: (args: { lang: string, content: string; }) => React.ReactNode; } | undefined;
        const canUseShiki = Boolean(
            showShiki
            && Vencord?.Plugins?.isPluginEnabled?.("ShikiCodeblocks")
            && shikiPlugin?.renderHighlighter
            && (
                !isPerformanceMode
                || (canUseShikiInPerf && (forceShikiInPerformanceMode || text.length <= shikiCharLimit))
            )
        );

        if (canUseShiki) {
            try {
                const shikiContainerEl = document.createElement("div");
                shikiContainerEl.style.padding = "0";
                shikiContainerEl.style.setProperty("--text-default", textNormal);
                shikiContainerEl.style.setProperty("--background-base-lower", bgSecondary);
                shikiContainerEl.style.userSelect = "text";
                shikiContainerEl.style.setProperty("-webkit-user-select", "text");
                content.appendChild(shikiContainerEl);
                searchableRoot = shikiContainerEl;
                useRangeSearch = true;

                renderRoot = createRoot(shikiContainerEl);
                renderRoot.render(
                    shikiPlugin!.renderHighlighter!({
                        lang: inferLanguage(filename, text),
                        content: text
                    })
                );
                return;
            } catch (err) {
                console.error("[FullLogViewer] Failed to render Shiki", err);
            }
        }

        const pre = document.createElement("pre");
        pre.style.margin = "0";
        pre.style.whiteSpace = "pre";
        pre.style.wordBreak = "normal";
        pre.style.overflowWrap = "normal";
        pre.style.fontFamily = "var(--font-code)";
        pre.style.fontSize = "12px";
        pre.style.lineHeight = "1.45";
        pre.style.color = textNormal;
        pre.style.userSelect = "text";
        pre.style.setProperty("-webkit-user-select", "text");
        pre.textContent = withLineNumbers(text, getLineCount(text));

        content.appendChild(pre);
        searchableRoot = pre;
        useRangeSearch = false;
    };

    const renderEditor = () => {
        const editorWrap = document.createElement("div");
        editorWrap.style.position = "relative";
        editorWrap.style.width = "100%";
        editorWrap.style.height = "100%";
        editorWrap.style.border = `1px solid ${borderColor}`;
        editorWrap.style.borderRadius = "10px";
        editorWrap.style.background = bgSecondary;
        editorWrap.style.overflow = "hidden";
        editorWrap.style.boxSizing = "border-box";

        const highlightLayer = document.createElement("pre");
        highlightLayer.style.position = "absolute";
        highlightLayer.style.inset = "0";
        highlightLayer.style.margin = "0";
        highlightLayer.style.padding = "14px";
        highlightLayer.style.fontFamily = "var(--font-code)";
        highlightLayer.style.fontSize = "12px";
        highlightLayer.style.lineHeight = "1.45";
        highlightLayer.style.color = textNormal;
        highlightLayer.style.whiteSpace = "pre-wrap";
        highlightLayer.style.wordBreak = "break-word";
        highlightLayer.style.overflow = "hidden";
        highlightLayer.style.boxSizing = "border-box";
        highlightLayer.style.pointerEvents = "none";
        highlightLayer.style.userSelect = "none";

        const textarea = document.createElement("textarea");
        textarea.value = currentText;
        textarea.style.width = "100%";
        textarea.style.height = "100%";
        textarea.style.position = "absolute";
        textarea.style.inset = "0";
        textarea.style.resize = "none";
        textarea.style.border = "none";
        textarea.style.background = "transparent";
        textarea.style.color = "transparent";
        textarea.style.caretColor = textNormal;
        textarea.style.padding = "14px";
        textarea.style.fontFamily = "var(--font-code)";
        textarea.style.fontSize = "12px";
        textarea.style.lineHeight = "1.45";
        textarea.style.outline = "none";
        textarea.style.boxSizing = "border-box";
        textarea.style.whiteSpace = "pre-wrap";
        textarea.style.wordBreak = "break-word";
        textarea.addEventListener("input", () => {
            render(0);
        });
        textarea.addEventListener("scroll", () => {
            highlightLayer.scrollTop = textarea.scrollTop;
            highlightLayer.scrollLeft = textarea.scrollLeft;
        });

        editor = textarea;
        editorHighlightLayer = highlightLayer;
        editorWrap.appendChild(highlightLayer);
        editorWrap.appendChild(textarea);
        content.appendChild(editorWrap);
        paintEditorHighlights(currentText, search.value.trim(), false);
        textarea.focus();
    };

    const renderContent = (retry = 0) => {
        renderRoot?.unmount();
        renderRoot = null;
        searchableRoot = null;
        searchIndex = null;
        editorHighlightLayer = null;
        editor = null;
        useRangeSearch = false;
        clearCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName);
        content.replaceChildren();
        currentMatches = [];
        currentRangeMatches = [];
        editorMatches = [];
        activeMatchIndex = -1;

        if (isEditing) {
            renderEditor();
            render(0);
            return;
        }

        renderViewer();

        const text = currentText;
        const { isPerformanceMode, maxHighlightedMatches, minSearchLength } = getPerformanceState(text);
        const query = search.value.trim();
        const shouldSearch = query.length >= minSearchLength;
        if (useRangeSearch && searchableRoot) {
            searchIndex ??= buildSearchIndex(searchableRoot);
            currentMatches = [];
            currentRangeMatches = shouldSearch
                ? findSearchRanges(searchIndex, query, maxHighlightedMatches)
                : [];
            if (canUseCssHighlights()) {
                setCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName, currentRangeMatches, -1);
            }
        } else {
            clearCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName);
            currentRangeMatches = [];
            currentMatches = shouldSearch && searchableRoot
                ? applySearchHighlight(searchableRoot, query, maxHighlightedMatches)
                : searchableRoot
                    ? applySearchHighlight(searchableRoot, "")
                    : [];
        }

        const matchCount = useRangeSearch ? currentRangeMatches.length : currentMatches.length;
        if (shouldSearch && matchCount === 0 && retry < 10) {
            if (useRangeSearch && searchIndex?.segments.length === 0) {
                searchIndex = null;
            }
            const shikiIsEnabled = showShiki && Vencord?.Plugins?.isPluginEnabled?.("ShikiCodeblocks");
            if (shikiIsEnabled) {
                setTimeout(() => renderContent(retry + 1), 80);
            }
        }

        if (matchCount > 0) {
            focusMatch(0);
        }

        if (isPerformanceMode) {
            box.style.boxShadow = "none";
        } else {
            box.style.boxShadow = "0 20px 60px rgba(0,0,0,0.45)";
        }

        updateStats();
    };

    const render = (retry = 0) => {
        if (isEditing) {
            currentMatches = [];
            currentRangeMatches = [];

            const text = editor?.value ?? currentText;
            const { query, shouldSearch } = updateEditorMatches(text);

            paintEditorHighlights(text, query, shouldSearch);
            updateStats();
            return;
        }

        if (!searchableRoot) {
            currentMatches = [];
            currentRangeMatches = [];
            editorMatches = [];
            activeMatchIndex = -1;
            updateStats();
            return;
        }

        const { maxHighlightedMatches, minSearchLength } = getPerformanceState(currentText);
        const query = search.value.trim();
        const shouldSearch = query.length >= minSearchLength;
        if (useRangeSearch) {
            searchIndex ??= buildSearchIndex(searchableRoot);
            currentMatches = [];
            currentRangeMatches = shouldSearch
                ? findSearchRanges(searchIndex, query, maxHighlightedMatches)
                : [];
            if (canUseCssHighlights()) {
                setCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName, currentRangeMatches, -1);
            }
        } else {
            clearCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName);
            currentRangeMatches = [];
            currentMatches = shouldSearch
                ? applySearchHighlight(searchableRoot, query, maxHighlightedMatches)
                : applySearchHighlight(searchableRoot, "");
        }

        const matchCount = useRangeSearch ? currentRangeMatches.length : currentMatches.length;
        if (shouldSearch && matchCount === 0 && retry < 10) {
            if (useRangeSearch && searchIndex?.segments.length === 0) {
                searchIndex = null;
            }
            setTimeout(() => render(retry + 1), 80);
        }

        if (matchCount > 0) {
            focusMatch(0);
        } else {
            activeMatchIndex = -1;
        }

        updateStats();
    };

    const onSearchInput = () => {
        if (searchDebounce != null) {
            window.clearTimeout(searchDebounce);
        }
        const { isPerformanceMode } = getPerformanceState(currentText);
        searchDebounce = window.setTimeout(() => {
            render(0);
            searchDebounce = null;
        }, isPerformanceMode ? 220 : 90);
    };
    search.addEventListener("input", onSearchInput);

    prevBtn.onclick = () => {
        if (isEditing && editor) updateEditorMatches(editor.value);
        focusMatch(activeMatchIndex - 1);
    };
    nextBtn.onclick = () => {
        if (isEditing && editor) updateEditorMatches(editor.value);
        focusMatch(activeMatchIndex + 1);
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            const selectedText = window.getSelection?.()?.toString() ?? "";
            if (selectedText) {
                e.preventDefault();
                void navigator.clipboard.writeText(selectedText);
            }
            return;
        }

        if (e.key === "Escape") {
            cleanup();
        }
    };

    const cleanup = () => {
        if (didCleanup) return;
        didCleanup = true;
        document.removeEventListener("keydown", onKeyDown);
        search.removeEventListener("input", onSearchInput);
        if (searchDebounce != null) {
            window.clearTimeout(searchDebounce);
            searchDebounce = null;
        }
        renderRoot?.unmount();
        clearCssSearchHighlights(cssHitHighlightName, cssActiveHighlightName);
        cssHighlightStyle.remove();
        overlay.remove();
    };

    perfToggleBtn.onclick = () => {
        const { isPerformanceMode } = getPerformanceState(currentText);
        const nextManualMode = !isPerformanceMode;
        onManualPerformanceModeChange?.(nextManualMode);
        cleanup();
        openLogModal(filename, currentText, nextManualMode, onManualPerformanceModeChange);
    };

    editBtn.onclick = () => {
        if (isEditing) {
            const editedText = editor?.value ?? currentText;
            if (!attachFileToCurrentChannel(filename, editedText)) {
                return;
            }
            currentText = editedText;
            isEditing = false;
            cleanup();
            return;
        }

        isEditing = true;
        renderContent();
    };

    closeEditBtn.onclick = () => {
        currentText = editor?.value ?? currentText;
        isEditing = false;
        renderContent();
    };

    overlay.addEventListener("click", e => {
        if (e.target === overlay) cleanup();
    });

    document.addEventListener("keydown", onKeyDown);

    closeBtn.onclick = cleanup;

    header.appendChild(title);
    header.appendChild(search);
    header.appendChild(prevBtn);
    header.appendChild(nextBtn);
    header.appendChild(copyBtn);
    header.appendChild(editBtn);
    header.appendChild(closeEditBtn);
    if (performanceModeEnabled && allowManualPerformanceToggleInViewer) {
        header.appendChild(perfToggleBtn);
    }
    header.appendChild(closeBtn);

    box.appendChild(header);
    box.appendChild(stats);
    box.appendChild(content);
    overlay.appendChild(box);
    (overlay as { vcCleanup?: () => void; }).vcCleanup = cleanup;
    document.body.appendChild(overlay);

    renderContent();
    search.focus();
}

function getFullFileUrlsFromButton(button: HTMLButtonElement, fileName: string, attachmentUrl?: string | null): string[] {
    const lowerName = fileName.toLowerCase();
    const attachmentRoot = button.closest("[class*=attachment]") ?? button.closest("[class*=container]") ?? button.parentElement;
    const getCandidatesFrom = (root: ParentNode) => {
        return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
            .map(link => link.href)
            .filter(Boolean)
            .filter(href => href.includes("/attachments/") || href.toLowerCase().includes(lowerName));
    };

    const localCandidates = getCandidatesFrom((attachmentRoot ?? document) as ParentNode);
    const baseCandidates = localCandidates.length ? localCandidates : getCandidatesFrom(document);

    const prioritizedCandidates = attachmentUrl ? [attachmentUrl, ...baseCandidates] : baseCandidates;
    const sorted = [...prioritizedCandidates].sort((a, b) => {
        const aExact = isExactFileUrl(a, lowerName);
        const bExact = isExactFileUrl(b, lowerName);
        return Number(bExact) - Number(aExact);
    });

    const expanded = sorted.flatMap(url => {
        const noQuery = url.split("?")[0] ?? url;
        const withDownload = url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
        return [url, noQuery, withDownload];
    });

    return Array.from(new Set(expanded));
}

async function getFullFileContents(
    button: HTMLButtonElement,
    fileName: string,
    previewContents: string,
    bytesLeft: number,
    attachmentUrl?: string | null
): Promise<string | null> {
    const candidates = getFullFileUrlsFromButton(button, fileName, attachmentUrl);
    if (!candidates.length) return null;

    let bestContent: string | null = null;

    for (const url of candidates) {
        let response: Response;
        try {
            response = await fetch(url);
        } catch {
            continue;
        }

        if (!response.ok) continue;

        let text: string;
        try {
            text = await response.text();
        } catch {
            continue;
        }

        if (!bestContent || text.length > bestContent.length) {
            bestContent = text;
        }

        if (text.replace(/\r\n/g, "\n") !== previewContents.replace(/\r\n/g, "\n")) {
            return text;
        }
    }

    if (!bestContent) return null;

    const previewNormalized = previewContents.replace(/\r\n/g, "\n");
    const bestNormalized = bestContent.replace(/\r\n/g, "\n");
    const stillLooksTruncated = bestNormalized === previewNormalized;

    return stillLooksTruncated ? null : bestContent;
}

function isExactFileUrl(url: string, lowerName: string): boolean {
    const path = url.split("?")[0]?.toLowerCase() ?? "";
    try {
        return decodeURIComponent(path).endsWith(`/${lowerName}`);
    } catch {
        return path.endsWith(`/${lowerName}`);
    }
}

function FullLogButton({ fileName, fileContents, bytesLeft, attachmentUrl }: { fileName: string, fileContents: string, bytesLeft: number, attachmentUrl?: string | null; }) {
    const [loading, setLoading] = useState(false);
    const [isDuplicate, setIsDuplicate] = useState(false);
    const [manualPerformanceMode, setManualPerformanceMode] = useState<boolean | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    if (!isSupportedFilename(fileName)) return null;

    useEffect(() => {
        const button = buttonRef.current;
        if (!button) return;

        const attachmentRoot = button.closest("[class*=attachment]") ?? button.closest("[class*=container]") ?? button.parentElement;
        if (!attachmentRoot) return;

        const allPluginButtons = Array.from(attachmentRoot.querySelectorAll<HTMLButtonElement>("button.vc-open-full-file-button"));
        setIsDuplicate(allPluginButtons[0] !== button);
    }, []);

    if (isDuplicate) return null;

    return (
        <Tooltip text={loading ? "Loading..." : "Open full file"}>
            {props => (
                <button
                    {...props}
                    ref={buttonRef}
                    className="vc-open-full-file-button"
                    style={{
                        marginLeft: "8px",
                        background: "transparent",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: "8px",
                        padding: "6px 10px",
                        cursor: loading ? "wait" : "pointer",
                        color: "var(--text-normal)"
                    }}
                    disabled={loading}
                    onClick={async event => {
                        try {
                            setLoading(true);
                            let contentToOpen = fileContents;

                            const downloadedContents = await getFullFileContents(
                                event.currentTarget,
                                fileName,
                                fileContents,
                                bytesLeft,
                                attachmentUrl
                            );

                            if (downloadedContents != null) {
                                contentToOpen = downloadedContents;
                            } else if (bytesLeft > 0) {
                                alert("Impossible de récupérer le fichier complet. Le lien de la pièce jointe est peut-être introuvable.");
                                return;
                            }

                            openLogModal(fileName || "log", contentToOpen, manualPerformanceMode, setManualPerformanceMode);
                        } catch (err) {
                            console.error("[FullLogViewer]", err);
                            alert("Impossible de charger le fichier complet. Vérifie que le lien de la pièce jointe est encore valide.");
                        } finally {
                            setLoading(false);
                        }
                    }}
                >
                    {loading ? "Loading..." : "Open full file"}
                </button>
            )}
        </Tooltip>
    );
}

export default definePlugin({
    name: "Files viewer",
    description: "Open full files",
    settings,
    authors: [
        {
            name: "lepoissongamer",
            id: 0n
        }
    ],

    patches: [
        {
            find: "#{intl::PREVIEW_BYTES_LEFT}",
            replacement: {
                match: /fileContents:(\i),bytesLeft:(\i)\}\):null,/,
                replace: "$&$self.addOpenButton({...arguments[0],fileContents:$1,bytesLeft:$2}),"
            }
        }
    ],

    addOpenButton: ErrorBoundary.wrap((attachmentData: {
        fileName?: string,
        filename?: string,
        name?: string,
        fileContents: string,
        bytesLeft: number,
        url?: string,
        downloadUrl?: string,
        attachmentUrl?: string,
        attachment?: { filename?: string, name?: string, url?: string, downloadUrl?: string; };
    }) => {
        const { fileContents, bytesLeft } = attachmentData;
        const fileName =
            attachmentData.fileName
            ?? attachmentData.filename
            ?? attachmentData.name
            ?? attachmentData.attachment?.filename
            ?? attachmentData.attachment?.name;
        const attachmentUrl =
            attachmentData.url
            ?? attachmentData.downloadUrl
            ?? attachmentData.attachmentUrl
            ?? attachmentData.attachment?.url
            ?? attachmentData.attachment?.downloadUrl
            ?? null;

        if (!fileName || typeof fileContents !== "string") return null;
        return <FullLogButton fileName={fileName} fileContents={fileContents} bytesLeft={bytesLeft} attachmentUrl={attachmentUrl} />;
    }, { noop: true })
});
