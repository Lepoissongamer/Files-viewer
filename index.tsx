/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { createRoot, React, Tooltip, useEffect, useRef, useState } from "@webpack/common";
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

    const lineCount = rawText.split("\n").length;
    const autoPerformanceMode = performanceModeEnabled && autoPerfEnabled;
    const autoDetectedPerformanceMode = performanceModeEnabled && (
        autoPerformanceMode
            ? rawText.length > autoCharThreshold || lineCount > autoLineThreshold
            : true
    );
    const isPerformanceMode = performanceModeEnabled && (manualPerformanceMode ?? autoDetectedPerformanceMode);
    const useLowGpuMode = isPerformanceMode;
    const maxHighlightedMatches = isPerformanceMode ? 250 : 2_500;
    const minSearchLength = isPerformanceMode ? 2 : 1;
    const shikiCharLimit = 120_000;
    const canUseShikiInPerf = !isPerformanceMode || forceShikiInPerformanceMode;
    const numberedText = withLineNumbers(rawText, lineCount);

    const bgPrimary = "var(--background-primary, #1e1f22)";
    const bgSecondary = "var(--background-secondary, #2b2d31)";
    const bgTertiary = "var(--background-tertiary, #313338)";
    const borderColor = "var(--background-modifier-accent, #4e5058)";
    const textNormal = "var(--text-normal, #dbdee1)";
    const textMuted = "var(--text-muted, #b5bac1)";
    const buttonSecondary = "var(--button-secondary-background, #4e5058)";
    const buttonDanger = "var(--button-danger-background, #da373c)";

    const existing = document.getElementById("vc-full-log-viewer-modal");
    if (existing) {
        (existing as { vcCleanup?: () => void; }).vcCleanup?.();
        existing.remove();
    }

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
    box.style.boxShadow = useLowGpuMode ? "none" : "0 20px 60px rgba(0,0,0,0.45)";

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
    prevBtn.textContent = "◀";
    prevBtn.title = "Back";
    prevBtn.style.padding = "8px 10px";
    prevBtn.style.borderRadius = "8px";
    prevBtn.style.border = "none";
    prevBtn.style.cursor = "pointer";
    prevBtn.style.background = buttonSecondary;
    prevBtn.style.color = textNormal;
    prevBtn.disabled = true;

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▶";
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
        await navigator.clipboard.writeText(rawText);
    };

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.padding = "8px 12px";
    closeBtn.style.borderRadius = "8px";
    closeBtn.style.border = "none";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.background = buttonDanger;
    closeBtn.style.color = "white";
    closeBtn.onclick = () => overlay.remove();

    const perfToggleBtn = document.createElement("button");
    perfToggleBtn.textContent = isPerformanceMode ? "Perf: ON" : "Perf: OFF";
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
    stats.textContent = `${rawText.length.toLocaleString()} character • ${lineCount.toLocaleString()} lignes`;

    const content = document.createElement("div");
    content.style.flex = "1";
    content.style.overflow = "auto";
    content.style.padding = "14px";
    content.style.background = bgPrimary;
    content.style.userSelect = "text";
    content.style.setProperty("-webkit-user-select", "text");
    content.style.cursor = "text";

    let renderRoot: Root | null = null;
    let searchableRoot: HTMLElement | null = null;
    const shikiPlugin = Vencord?.Plugins?.plugins?.ShikiCodeblocks as { renderHighlighter?: (args: { lang: string, content: string; }) => React.ReactNode; } | undefined;
    const canUseShiki = Boolean(
        showShiki
        && Vencord?.Plugins?.isPluginEnabled?.("ShikiCodeblocks")
        && shikiPlugin?.renderHighlighter
        && (
            !isPerformanceMode
            || (canUseShikiInPerf && (forceShikiInPerformanceMode || rawText.length <= shikiCharLimit))
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

            renderRoot = createRoot(shikiContainerEl);
            renderRoot.render(
                shikiPlugin!.renderHighlighter!({
                    lang: inferLanguage(filename, rawText),
                    content: rawText
                })
            );
        } catch (err) {
            console.error("[FullLogViewer] Failed to render Shiki", err);
        }
    }

    if (!renderRoot) {
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
        pre.textContent = numberedText;

        content.appendChild(pre);
        searchableRoot = pre;
    }

    let currentMatches: HTMLElement[] = [];
    let activeMatchIndex = -1;

    const focusMatch = (index: number) => {
        if (!currentMatches.length) return;
        const safeIndex = ((index % currentMatches.length) + currentMatches.length) % currentMatches.length;
        activeMatchIndex = safeIndex;

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

    const render = (retry = 0) => {
        if (!searchableRoot) return;
        const query = search.value.trim();
        const shouldSearch = query.length >= minSearchLength;
        currentMatches = shouldSearch
            ? applySearchHighlight(searchableRoot, query, maxHighlightedMatches)
            : applySearchHighlight(searchableRoot, "");

        if (shouldSearch && currentMatches.length === 0 && canUseShiki && retry < 10) {
            setTimeout(() => render(retry + 1), 80);
        }

        prevBtn.disabled = currentMatches.length === 0;
        nextBtn.disabled = currentMatches.length === 0;

        if (currentMatches.length > 0) {
            focusMatch(0);
        } else {
            activeMatchIndex = -1;
        }

        const matchPart = shouldSearch
            ? ` • ${currentMatches.length.toLocaleString()} result${currentMatches.length ? ` • ${activeMatchIndex + 1}/${currentMatches.length}` : ""}`
            : "";
        const perfPart = isPerformanceMode
            ? ` • perf mode (${manualPerformanceMode == null ? (autoPerformanceMode ? "auto" : "manuel-global") : "manuel-viewer"}, search >= ${minSearchLength} chars, max ${maxHighlightedMatches.toLocaleString()} highlights)`
            : "";
        const gpuPart = useLowGpuMode ? " • low-gpu mode" : "";
        stats.textContent = `${rawText.length.toLocaleString()} character • ${lineCount.toLocaleString()} lignes${matchPart}${perfPart}${gpuPart}`;
    };

    let searchDebounce: number | null = null;
    const onSearchInput = () => {
        if (searchDebounce != null) {
            window.clearTimeout(searchDebounce);
        }
        searchDebounce = window.setTimeout(() => {
            render(0);
            searchDebounce = null;
        }, isPerformanceMode ? 220 : 90);
    };
    search.addEventListener("input", onSearchInput);

    prevBtn.onclick = () => focusMatch(activeMatchIndex - 1);
    nextBtn.onclick = () => focusMatch(activeMatchIndex + 1);

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

    let didCleanup = false;
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
        overlay.remove();
    };

    perfToggleBtn.onclick = () => {
        const nextManualMode = !isPerformanceMode;
        onManualPerformanceModeChange?.(nextManualMode);
        cleanup();
        openLogModal(filename, rawText, nextManualMode, onManualPerformanceModeChange);
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
                match: /fileName:(\i),fileSize:\i}\),(?=.{0,75}?setLanguage:)(?<=fileContents:(\i),bytesLeft:(\i).+?)/g,
                replace: "$&$self.addOpenButton({fileName:$1,fileContents:$2,bytesLeft:$3,url:arguments[0]?.url,downloadUrl:arguments[0]?.downloadUrl,attachmentUrl:arguments[0]?.attachmentUrl,attachment:arguments[0]?.attachment}),"
            }
        }
    ],

    addOpenButton: ErrorBoundary.wrap((attachmentData: {
        fileName: string,
        fileContents: string,
        bytesLeft: number,
        url?: string,
        downloadUrl?: string,
        attachmentUrl?: string,
        attachment?: { url?: string, downloadUrl?: string; };
    }) => {
        const { fileName, fileContents, bytesLeft } = attachmentData;
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
