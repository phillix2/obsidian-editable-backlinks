import {
  Plugin,
  MarkdownView,
  MarkdownRenderer,
  TFile,
  WorkspaceLeaf,
  debounce,
  Component,
} from "obsidian";

interface BacklinkBlock {
  sourceFile: TFile;
  lineStart: number;
  lineEnd: number;
  content: string;
  depth: number;
}

export default class EditableBacklinksPlugin extends Plugin {
  private refreshDebounced: () => void;
  private renderComponent: Component;
  private globalKeyHandler: ((ev: KeyboardEvent) => void) | null = null;

  async onload() {
    this.renderComponent = new Component();
    this.renderComponent.load();
    this.refreshDebounced = debounce(() => this.refreshActiveLeaf(), 1000, true);

    // Global capture-phase handler registered ONCE at plugin load
    // Intercepts shortcuts before Obsidian when editing backlink textareas
    this.globalKeyHandler = (ev: KeyboardEvent) => {
      const textarea = document.activeElement;
      if (!textarea || !(textarea instanceof HTMLTextAreaElement) || !textarea.classList.contains("eb-textarea")) return;

      // Task status shortcuts
      if (ev.ctrlKey || ev.metaKey || ev.altKey) {
        const commandId = this.findMatchingCommand(ev);
        if (commandId && commandId.startsWith("task-enhancer:set-status-")) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          const statusName = commandId.replace("task-enhancer:set-status-", "");
          this.applyTaskStatusInTextarea(textarea, statusName);
        }
      }
    };
    document.addEventListener("keydown", this.globalKeyHandler, true);


    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.refreshDebounced();
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
        if (leaf) setTimeout(() => this.renderForLeaf(leaf), 300);
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        setTimeout(() => this.refreshActiveLeaf(), 300);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => this.refreshActiveLeaf(), 800);
    });
  }

  onunload() {
    this.renderComponent.unload();
    document.querySelectorAll(".editable-backlinks-section").forEach((el) => el.remove());
    if (this.globalKeyHandler) {
      document.removeEventListener("keydown", this.globalKeyHandler, true);
    }
  }

  private refreshActiveLeaf() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.leaf) this.renderForLeaf(view.leaf);
  }

  private async renderForLeaf(leaf: WorkspaceLeaf) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const file = view.file;
    if (!file) return;

    const container = view.containerEl.querySelector(".cm-sizer")
      || view.containerEl.querySelector(".markdown-preview-sizer")
      || view.containerEl.querySelector(".cm-scroller")
      || view.containerEl.querySelector(".markdown-preview-view");
    if (!container) return;

    container.querySelectorAll(".editable-backlinks-section").forEach((el) => el.remove());

    const backlinkBlocks = await this.getBacklinkBlocks(file);
    if (backlinkBlocks.length === 0) return;

    const deduplicated = this.deduplicateBlocks(backlinkBlocks);
    const grouped = this.groupByFile(deduplicated);

    const section = document.createElement("div");
    section.addClass("editable-backlinks-section");

    // Header
    const fileCount = Object.keys(grouped).length;
    const header = section.createDiv({ cls: "eb-header" });
    header.createSpan({ text: `Linked References`, cls: "eb-title" });
    header.createSpan({ text: ` (${fileCount})`, cls: "eb-count" });

    const collapseAllBtn = header.createSpan({ cls: "eb-collapse-all", text: "▾" });
    let allCollapsed = false;
    const arrows: HTMLElement[] = [];
    const blockContainers: HTMLElement[] = [];

    collapseAllBtn.addEventListener("click", () => {
      allCollapsed = !allCollapsed;
      collapseAllBtn.setText(allCollapsed ? "▸" : "▾");
      blockContainers.forEach((el) => el.style.display = allCollapsed ? "none" : "");
      arrows.forEach((a) => a.setText(allCollapsed ? "▸" : "▾"));
    });

    for (const [filePath, blocks] of Object.entries(grouped)) {
      const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(sourceFile instanceof TFile)) continue;

      const groupEl = section.createDiv({ cls: "eb-group" });
      const fileHeader = groupEl.createDiv({ cls: "eb-file-header" });
      const arrow = fileHeader.createSpan({ cls: "eb-arrow", text: "▾" });
      const fileName = fileHeader.createSpan({ cls: "eb-file-name", text: sourceFile.basename });
      arrows.push(arrow);

      // Click on file name navigates to that page
      fileName.addEventListener("click", (e) => {
        e.stopPropagation();
        const newTab = (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey;
        this.app.workspace.openLinkText(sourceFile.path, "", newTab);
      });

      const blocksEl = groupEl.createDiv({ cls: "eb-blocks" });
      blockContainers.push(blocksEl);

      fileHeader.addEventListener("click", () => {
        const collapsed = blocksEl.style.display === "none";
        blocksEl.style.display = collapsed ? "" : "none";
        arrow.setText(collapsed ? "▾" : "▸");
      });

      for (const block of blocks) {
        const blockEl = blocksEl.createDiv({ cls: "eb-block" });
        await this.renderBlock(blockEl, block);
      }
    }

    container.appendChild(section);
  }

  private async renderBlock(blockEl: HTMLElement, block: BacklinkBlock) {
    const rendered = blockEl.createDiv({ cls: "eb-rendered" });
    this.renderLines(rendered, block);
  }

  // Render each line as individual div with inline editing (like client-outline)
  private renderLines(rendered: HTMLElement, block: BacklinkBlock) {
    rendered.empty();
    const sourceLines = block.content.split("\n");
    const sC: Record<string, string> = { " ": "#e03131", "w": "#e67700", "?": "#7c3aed", "x": "#2b8a3e" };
    const sN: Record<string, string> = { " ": "TODO", "w": "WAITING", "?": "ASK", "x": "DONE" };
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Render wikilinks as clickable links
    const renderWikilinks = (text: string) => {
      return esc(text).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, display) => {
        const name = display || path;
        return `<a class="internal-link" data-href="${path}" href="${path}">${esc(name)}</a>`;
      });
    };

    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      const trimmed = line.trim();

      // Skip metadata lines
      if (trimmed.startsWith("pm::") || trimmed.startsWith("- pm::") ||
          trimmed.match(/^(?:-\s*)?ref::\s/) || trimmed.match(/^(?:-\s*)?notas::\s/)) continue;
      if (!trimmed) continue;

      // Parse line
      const indent = (line.match(/^(\t*)/)?.[1] || "").length + (line.match(/^( *)/)?.[1] || "").length / 2;
      const taskMatch = trimmed.match(/^[-*+]\s+\[([^\]]+)\]\s+(.*)/);
      const bulletMatch = !taskMatch ? trimmed.match(/^[-*+]\s+(.*)/) : null;
      const textContent = taskMatch ? taskMatch[2] : (bulletMatch ? bulletMatch[1] : trimmed);
      const status = taskMatch ? taskMatch[1] : null;

      const row = rendered.createDiv();
      row.style.cssText = `margin:1px 0;padding-left:${indent * 16}px;`;

      if (status !== null) {
        // Task with checkbox and status badge
        const isDone = status === "x" || status === "X";
        const c = sC[status] || "#888";
        const n = sN[status] || status.toUpperCase();

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = isDone;
        cb.style.cssText = `margin-right:5px;vertical-align:middle;cursor:pointer;accent-color:${c};`;
        row.appendChild(cb);

        if (!isDone) {
          const badge = document.createElement("span");
          badge.innerHTML = `<span style="color:${c};font-weight:700;margin-right:4px">${n}</span>`;
          row.appendChild(badge);
        }

        const nameSpan = document.createElement("span");
        nameSpan.innerHTML = renderWikilinks(textContent);
        if (isDone) { nameSpan.style.textDecoration = "line-through"; nameSpan.style.opacity = "0.5"; }
        nameSpan.style.cssText += "cursor:text;display:inline;";
        row.appendChild(nameSpan);

        this.makeSpanEditable(nameSpan, sourceLines, i, block, rendered);
        this.attachLinkHandlers(nameSpan, block);
      } else {
        // Plain bullet or text
        const textSpan = document.createElement("span");
        if (bulletMatch) {
          textSpan.innerHTML = "• " + renderWikilinks(textContent);
        } else {
          textSpan.innerHTML = renderWikilinks(textContent);
        }
        textSpan.style.cursor = "text";
        row.appendChild(textSpan);

        this.makeSpanEditable(textSpan, sourceLines, i, block, rendered);
        this.attachLinkHandlers(textSpan, block);
      }
    }
  }

  // Make a span editable on click with contenteditable, cursor at click position
  private makeSpanEditable(span: HTMLElement, sourceLines: string[], lineIdx: number, block: BacklinkBlock, rendered: HTMLElement) {
    span.addEventListener("click", (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("a")) return;
      if (span.isContentEditable) return;
      e.stopPropagation();

      const origLine = sourceLines[lineIdx];
      const prefixMatch = origLine.match(/^(\s*[-*+]\s*(?:\[.\]\s*)?)/);
      const prefix = prefixMatch ? prefixMatch[1] : "";
      const textPart = origLine.substring(prefix.length);

      const x = e.clientX, y = e.clientY;
      span.textContent = textPart;
      span.setAttribute("contenteditable", "plaintext-only");
      span.style.outline = "none";
      span.style.display = "inline-block";
      span.style.minWidth = "60%";
      span.style.paddingRight = "30px";
      span.focus();

      // Place cursor at click position
      try {
        let range: Range | null = null;
        if ((document as any).caretPositionFromPoint) {
          const pos = (document as any).caretPositionFromPoint(x, y);
          if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }
        } else if (document.caretRangeFromPoint) {
          range = document.caretRangeFromPoint(x, y);
        }
        if (range) { const sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); } }
      } catch (_) {}

      const finish = async (save: boolean) => {
        if (!span.isContentEditable) return;
        span.removeAttribute("contenteditable");
        span.style.display = "";
        span.style.paddingRight = "";
        span.style.minWidth = "";
        const newText = span.textContent?.trim() || "";

        if (save && newText !== textPart.trim()) {
          sourceLines[lineIdx] = prefix + newText;
          block.content = sourceLines.join("\n");
          await this.saveEdit(block, block.content);
        }
        // Re-render all lines
        this.renderLines(rendered, block);
      };

      span.addEventListener("blur", () => finish(true), { once: true });
      span.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); span.blur(); }
        if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    });
  }


  private htmlToMarkdown(el: HTMLElement): string {
    let md = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        md += node.textContent || "";
      } else if (node instanceof HTMLElement) {
        // Skip child lists
        if (node.matches("ul, ol")) continue;

        const tag = node.tagName.toLowerCase();
        if (tag === "strong" || tag === "b") {
          md += `**${this.htmlToMarkdown(node)}**`;
        } else if (tag === "em" || tag === "i") {
          md += `*${this.htmlToMarkdown(node)}*`;
        } else if (tag === "del" || tag === "s") {
          md += `~~${this.htmlToMarkdown(node)}~~`;
        } else if (tag === "code") {
          md += `\`${node.textContent || ""}\``;
        } else if (tag === "a") {
          const href = node.getAttribute("data-href") || node.getAttribute("href") || "";
          const text = node.textContent || "";
          if (node.classList.contains("internal-link")) {
            if (text === href || text === href.replace(/.*\//, "")) {
              md += `[[${href}]]`;
            } else {
              md += `[[${href}|${text}]]`;
            }
          } else {
            md += `[${text}](${href})`;
          }
        } else if (tag === "span") {
          // Tags, dates, etc. — just get text
          md += node.textContent || "";
        } else {
          md += this.htmlToMarkdown(node);
        }
      }
    }
    return md;
  }

  private attachLinkHandlers(container: HTMLElement, block: BacklinkBlock) {
    container.querySelectorAll("a.internal-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute("href") || link.getAttribute("data-href") || "";
        const newTab = (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey;
        if (href) this.app.workspace.openLinkText(href, block.sourceFile.path, newTab);
      });
    });
    container.querySelectorAll("a.external-link").forEach((link) => {
      link.addEventListener("click", (e) => { e.stopPropagation(); });
    });
  }


  private findMatchingCommand(ev: KeyboardEvent): string | null {
    const modifiers: string[] = [];
    if (ev.ctrlKey || ev.metaKey) modifiers.push("Ctrl");
    if (ev.shiftKey) modifiers.push("Shift");
    if (ev.altKey) modifiers.push("Alt");

    const codeKey = ev.code.replace("Digit", "").replace("Key", "");

    const hotkeyManager = (this.app as any).hotkeyManager;
    if (!hotkeyManager) return null;

    const customKeys = hotkeyManager.customKeys || {};
    const defaultKeys = hotkeyManager.defaultKeys || {};
    const allKeys = { ...defaultKeys, ...customKeys };

    for (const [commandId, hotkeys] of Object.entries(allKeys)) {
      if (!Array.isArray(hotkeys)) continue;
      for (const hk of hotkeys as any[]) {
        if (!hk || !hk.modifiers || !hk.key) continue;
        const hkMods = [...hk.modifiers].sort();
        const evMods = [...modifiers].sort();
        if (hkMods.length !== evMods.length) continue;
        if (!hkMods.every((m: string, i: number) => m === evMods[i])) continue;
        const hkKey = hk.key.toLowerCase();
        if (hkKey === ev.key.toLowerCase() || hkKey === codeKey.toLowerCase() || hkKey === ev.code.toLowerCase()) {
          return commandId;
        }
      }
    }
    return null;
  }

  private applyTaskStatusInTextarea(textarea: HTMLTextAreaElement, statusName: string) {
    const taskEnhancer = (this.app as any).plugins?.plugins?.["task-enhancer"];
    if (!taskEnhancer?.settings?.statuses) return;

    const status = taskEnhancer.settings.statuses.find(
      (s: any) => s.name.toLowerCase().replace(/\s+/g, "-") === statusName
    );
    if (!status) return;

    const value = textarea.value;
    const cursorPos = textarea.selectionStart;

    // Find the line the cursor is on
    const lineStart = value.lastIndexOf("\n", cursorPos - 1) + 1;
    const lineEnd = value.indexOf("\n", cursorPos);
    const line = value.substring(lineStart, lineEnd === -1 ? value.length : lineEnd);

    const taskMatch = line.match(/^(\s*[-*+]\s*)\[(.)\](\s.*)/);
    if (taskMatch) {
      const newLine = `${taskMatch[1]}[${status.symbol}]${taskMatch[3]}`;
      const before = value.substring(0, lineStart);
      const after = value.substring(lineEnd === -1 ? value.length : lineEnd);
      textarea.value = before + newLine + after;
      textarea.selectionStart = textarea.selectionEnd = cursorPos;
    } else {
      // Convert to task
      const bulletMatch = line.match(/^(\s*[-*+]\s*)(.*)/);
      if (bulletMatch) {
        const newLine = `${bulletMatch[1]}[${status.symbol}] ${bulletMatch[2]}`;
        const before = value.substring(0, lineStart);
        const after = value.substring(lineEnd === -1 ? value.length : lineEnd);
        textarea.value = before + newLine + after;
        textarea.selectionStart = textarea.selectionEnd = cursorPos + 4; // [x] + space
      }
    }
  }

  private applyTaskStatusLabels(container: HTMLElement) {
    // Apply status labels to checkboxes rendered by MarkdownRenderer
    // This replicates what Task Enhancer does via CSS, but for our rendered blocks
    const taskItems = container.querySelectorAll("li.task-list-item");
    taskItems.forEach((li) => {
      const el = li as HTMLElement;
      const dataTask = el.getAttribute("data-task") || "";
      const checkbox = el.querySelector("input.task-list-item-checkbox") as HTMLInputElement;
      if (!checkbox) return;

      // Determine status from data-task attribute
      let statusName = "";
      let statusColor = "";
      let isDone = false;

      // Read from Task Enhancer settings if available
      const taskEnhancer = (this.app as any).plugins?.plugins?.["task-enhancer"];
      if (taskEnhancer?.settings?.statuses) {
        const statuses = taskEnhancer.settings.statuses;
        for (const s of statuses) {
          if (s.symbol === dataTask || (s.symbol === " " && dataTask === "")) {
            statusName = s.name;
            statusColor = s.color;
            isDone = s.isDone;
            break;
          }
        }
      } else {
        // Fallback defaults
        const defaults: Record<string, { name: string; color: string; done: boolean }> = {
          "": { name: "TODO", color: "#e03131", done: false },
          " ": { name: "TODO", color: "#e03131", done: false },
          "w": { name: "WAITING", color: "#e67700", done: false },
          "?": { name: "ASK", color: "#7c3aed", done: false },
          "x": { name: "DONE", color: "#2b8a3e", done: true },
        };
        const d = defaults[dataTask];
        if (d) { statusName = d.name; statusColor = d.color; isDone = d.done; }
      }

      if (!statusName) return;

      // Remove any existing status text rendered as plain text by MarkdownRenderer
      const allStatuses = taskEnhancer?.settings?.statuses?.map((s: any) => s.name) || ["TODO", "WAITING", "ASK", "DONE"];
      const statusRegex = new RegExp(`^\\s*(${allStatuses.join("|")})\\s*`, "i");
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (textNode.textContent && statusRegex.test(textNode.textContent) && textNode.parentElement?.tagName !== "SPAN") {
          textNode.textContent = textNode.textContent.replace(statusRegex, " ");
        }
      }

      // Add status label after checkbox (only if not already present)
      const existingLabel = el.querySelector(".eb-task-label");
      if (existingLabel) existingLabel.remove();

      const label = document.createElement("span");
      label.className = "eb-task-label";
      label.textContent = statusName;
      label.style.color = statusColor;
      label.style.fontWeight = "700";
      label.style.fontSize = "0.85em";
      label.style.marginRight = "4px";
      checkbox.insertAdjacentElement("afterend", label);

      // Style checkbox border
      if (!isDone) {
        checkbox.style.appearance = "none";
        checkbox.style.webkitAppearance = "none";
        checkbox.style.border = `2px solid ${statusColor}`;
        checkbox.style.borderRadius = "3px";
        checkbox.style.width = "1em";
        checkbox.style.height = "1em";
        checkbox.style.background = "transparent";
        checkbox.style.cursor = "pointer";
        checkbox.checked = false;
      } else {
        checkbox.style.accentColor = statusColor;
        el.style.textDecoration = "line-through";
        el.style.color = "#868e96";
      }
    });
  }

  private async saveEdit(block: BacklinkBlock, newContent: string) {
    const file = block.sourceFile;
    const fullContent = await this.app.vault.read(file);
    const lines = fullContent.split("\n");
    const newLines = newContent.split("\n");
    lines.splice(block.lineStart, block.lineEnd - block.lineStart + 1, ...newLines);
    await this.app.vault.modify(file, lines.join("\n"));
    block.lineEnd = block.lineStart + newLines.length - 1;
  }

  private async getBacklinkBlocks(file: TFile): Promise<BacklinkBlock[]> {
    const blocks: BacklinkBlock[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    const backlinkFiles: TFile[] = [];
    for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
      if (links[file.path] && sourcePath !== file.path) {
        const sf = this.app.vault.getAbstractFileByPath(sourcePath);
        if (sf instanceof TFile) backlinkFiles.push(sf);
      }
    }

    for (const sourceFile of backlinkFiles) {
      const content = await this.app.vault.cachedRead(sourceFile);
      const lines = content.split("\n");
      const linkPatterns = [
        `[[${file.path}]]`,
        `[[${file.basename}]]`,
        `[[${file.basename}|`,
      ];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!linkPatterns.some((p) => line.includes(p))) continue;

        const depth = this.getDepth(line);
        let endLine = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "") { endLine = j - 1; break; }
          if (this.getDepth(lines[j]) <= depth) { endLine = j - 1; break; }
          endLine = j;
        }

        let startLine = i;
        if (depth > 0) {
          for (let j = i - 1; j >= 0; j--) {
            if (lines[j].trim() === "") break;
            if (this.getDepth(lines[j]) < depth) { startLine = j; break; }
          }
        }

        blocks.push({
          sourceFile,
          lineStart: startLine,
          lineEnd: endLine,
          content: lines.slice(startLine, endLine + 1).join("\n"),
          depth,
        });
      }
    }
    return blocks;
  }

  private getDepth(line: string): number {
    const m = line.match(/^(\s*)/);
    return m ? m[1].replace(/\t/g, "  ").length : 0;
  }

  private deduplicateBlocks(blocks: BacklinkBlock[]): BacklinkBlock[] {
    return blocks.filter((block, idx) => {
      for (let i = 0; i < blocks.length; i++) {
        if (i === idx) continue;
        const o = blocks[i];
        if (
          o.sourceFile.path === block.sourceFile.path &&
          o.lineStart <= block.lineStart &&
          o.lineEnd >= block.lineEnd &&
          (o.lineStart < block.lineStart || o.lineEnd > block.lineEnd)
        ) return false;
      }
      return true;
    });
  }

  private groupByFile(blocks: BacklinkBlock[]): Record<string, BacklinkBlock[]> {
    const g: Record<string, BacklinkBlock[]> = {};
    for (const b of blocks) {
      if (!g[b.sourceFile.path]) g[b.sourceFile.path] = [];
      g[b.sourceFile.path].push(b);
    }
    return g;
  }
}
