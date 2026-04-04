import {
  Plugin,
  MarkdownView,
  TFile,
  WorkspaceLeaf,
  debounce,
  Component,
  setIcon,
} from "obsidian";

interface BacklinkBlock {
  sourceFile: TFile;
  lineStart: number;
  lineEnd: number;
  content: string;
  depth: number;
  breadcrumb: string[];  // parent hierarchy for context
}

export default class EditableBacklinksPlugin extends Plugin {
  private refreshDebounced: () => void;
  private renderComponent: Component;

  async onload() {
    this.renderComponent = new Component();
    this.renderComponent.load();
    this.refreshDebounced = debounce(() => this.refreshActiveLeaf(), 1000, true);

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

    // Sort files: newest first. Parse date from basename (e.g. "Friday, 27-09-2024")
    const parseDate = (name: string): number => {
      const m = name.match(/(\d{2})-(\d{2})-(\d{4})/);
      if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime();
      return 0;
    };
    const sortedEntries = Object.entries(grouped).sort((a, b) => {
      const nameA = this.app.vault.getAbstractFileByPath(a[0])?.name || a[0];
      const nameB = this.app.vault.getAbstractFileByPath(b[0])?.name || b[0];
      return parseDate(nameB) - parseDate(nameA);
    });

    for (const [filePath, blocks] of sortedEntries) {
      const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
      if (!(sourceFile instanceof TFile)) continue;

      const groupEl = section.createDiv({ cls: "eb-group" });
      const fileHeader = groupEl.createDiv({ cls: "eb-file-header" });
      const arrow = fileHeader.createSpan({ cls: "eb-arrow", text: "▾" });
      const fileName = fileHeader.createSpan({ cls: "eb-file-name", text: sourceFile.basename });
      arrows.push(arrow);

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
        // Show breadcrumb if the block has parent context
        if (block.breadcrumb.length > 0) {
          const bcEl = blockEl.createDiv({ cls: "eb-breadcrumb" });
          bcEl.style.cssText = "color:var(--text-faint);font-size:0.8em;margin-bottom:2px;";
          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const rendered = block.breadcrumb.map(part => {
            return esc(part).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, display) => {
              const name = display || path;
              return `<a class="internal-link" data-href="${path}" href="${path}" style="color:var(--text-faint)">${esc(name)}</a>`;
            });
          }).join(" › ");
          bcEl.innerHTML = rendered;
          // Breadcrumb links: always navigate on click
          bcEl.querySelectorAll("a.internal-link").forEach((link) => {
            link.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const href = link.getAttribute("href") || link.getAttribute("data-href") || "";
              if (href) this.app.workspace.openLinkText(href, block.sourceFile.path, true);
            });
          });
        }
        const rendered = blockEl.createDiv({ cls: "eb-rendered" });
        this.renderLines(rendered, block);
      }
    }

    container.appendChild(section);
  }

  /* ── Render each line as individual div with inline editing and collapsible children ── */
  renderLines(rendered: HTMLElement, block: BacklinkBlock) {
    rendered.empty();
    const sourceLines = block.content.split("\n");
    const sC: Record<string, string> = { " ": "#e03131", "w": "#e67700", "?": "#7c3aed", "x": "#2b8a3e" };
    const sN: Record<string, string> = { " ": "TODO", "w": "WAITING", "?": "ASK", "x": "DONE" };
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const renderInline = (text: string) => {
      let html = esc(text);
      // Wikilinks: [[path]] or [[path|display]]
      html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, display) => {
        const name = display || path;
        return `<a class="internal-link" data-href="${path}" href="${path}">${esc(name)}</a>`;
      });
      // Bold: **text**
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Italic: *text* (but not inside bold)
      html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
      // Strikethrough: ~~text~~
      html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
      // Tags: #tag
      html = html.replace(/(^|\s)(#[a-zA-Z][\w/-]*)/g, '$1<span style="color:var(--text-accent);background:var(--background-modifier-hover);padding:1px 4px;border-radius:4px;font-size:0.9em">$2</span>');
      return html;
    };

    // Helper: classify metadata lines
    const isNotasLine = (t: string) => !!t.match(/^(?:-\s*)?notas::\s/);
    const isHiddenMeta = (t: string) =>
      t.startsWith("pm::") || t.startsWith("- pm::") ||
      !!t.match(/^(?:-\s*)?ref::\s/) ||
      !!t.match(/^(?:-\s*)?completed::\s/) || !!t.match(/^(?:-\s*)?id:/);
    const isMetaLine = (t: string) => isNotasLine(t) || isHiddenMeta(t);

    // Property line with its source index for editing
    interface PropLine { text: string; sourceIdx: number; }

    // First pass: collect visible lines (non-meta, non-empty) with parsed data
    interface ParsedLine { idx: number; indent: number; trimmed: string; line: string; taskMatch: RegExpMatchArray | null; bulletMatch: RegExpMatchArray | null; textContent: string; status: string | null; notasLines: PropLine[]; hiddenProps: PropLine[]; }
    const visible: ParsedLine[] = [];
    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i];
      const trimmed = line.trim();
      if (isMetaLine(trimmed)) continue;
      if (!trimmed) continue;

      const indent = (line.match(/^(\t*)/)?.[1] || "").length + (line.match(/^( *)/)?.[1] || "").length / 2;
      const taskMatch = trimmed.match(/^[-*+]\s+\[([^\]]+)\]\s+(.*)/);
      const bulletMatch = !taskMatch ? trimmed.match(/^[-*+]\s+(.*)/) : null;
      const textContent = taskMatch ? taskMatch[2] : (bulletMatch ? bulletMatch[1] : trimmed);
      const status = taskMatch ? taskMatch[1] : null;

      // Collect property lines that follow this task
      const notasLines: PropLine[] = [];
      const hiddenProps: PropLine[] = [];
      if (taskMatch) {
        for (let j = i + 1; j < sourceLines.length; j++) {
          const childTrimmed = sourceLines[j].trim();
          if (!childTrimmed) break;
          const childIndent = (sourceLines[j].match(/^(\t*)/)?.[1] || "").length + (sourceLines[j].match(/^( *)/)?.[1] || "").length / 2;
          if (childIndent <= indent) break;
          if (isNotasLine(childTrimmed)) {
            const clean = childTrimmed.replace(/^[-*+]\s*/, "");
            notasLines.push({ text: clean, sourceIdx: j });
          } else if (isHiddenMeta(childTrimmed)) {
            const clean = childTrimmed.replace(/^[-*+]\s*/, "");
            hiddenProps.push({ text: clean, sourceIdx: j });
          }
        }
      }

      visible.push({ idx: i, indent, trimmed, line, taskMatch, bulletMatch, textContent, status, notasLines, hiddenProps });
    }

    // Second pass: render with collapse arrows
    // Track which rows are "children containers" for collapse toggling
    const rows: { el: HTMLElement; indent: number }[] = [];

    for (let vi = 0; vi < visible.length; vi++) {
      const v = visible[vi];
      const { idx, indent, textContent, status, bulletMatch } = v;

      // Check if this line has children (next visible line has greater indent)
      const hasChildren = vi + 1 < visible.length && visible[vi + 1].indent > indent;

      const row = rendered.createDiv();
      row.style.cssText = `margin:1px 0;padding-left:${indent * 16}px;`;
      row.dataset.indent = String(indent);
      rows.push({ el: row, indent });

      // Add collapse arrow if has children
      if (hasChildren) {
        const arrow = document.createElement("span");
        arrow.textContent = "▼ ";
        arrow.style.cssText = "display:inline-block;width:16px;font-size:0.7em;vertical-align:middle;cursor:pointer;color:var(--text-faint);";
        arrow.addEventListener("click", (e) => {
          e.stopPropagation();
          const myIdx = rows.findIndex(r => r.el === row);
          const myIndent = indent;
          const isOpen = arrow.textContent?.includes("▼");
          arrow.textContent = isOpen ? "▶ " : "▼ ";
          // Toggle all following rows that are deeper than this one
          for (let j = myIdx + 1; j < rows.length; j++) {
            if (rows[j].indent <= myIndent) break;
            rows[j].el.style.display = isOpen ? "none" : "";
            // Reset nested arrows to collapsed state when hiding
            if (isOpen) {
              const nestedArrow = rows[j].el.querySelector(".eb-collapse-arrow") as HTMLElement;
              if (nestedArrow) nestedArrow.textContent = "▶ ";
            }
          }
        });
        arrow.className = "eb-collapse-arrow";
        row.appendChild(arrow);
      } else {
        // Spacer to keep alignment
        const spacer = document.createElement("span");
        spacer.style.cssText = "display:inline-block;width:16px;";
        row.appendChild(spacer);
      }

      if (status !== null) {
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
        nameSpan.innerHTML = renderInline(textContent);
        if (isDone) { nameSpan.style.textDecoration = "line-through"; nameSpan.style.opacity = "0.5"; }
        nameSpan.style.cssText += "cursor:text;display:inline;";
        row.appendChild(nameSpan);

        this.makeSpanEditable(nameSpan, sourceLines, idx, block, rendered);
        this.attachLinkHandlers(nameSpan, block);

        const childIndentPx = (indent + 1) * 16;

        // Render notas:: lines always visible, editable, indented under their task
        for (const nota of v.notasLines) {
          const notaRow = rendered.createDiv();
          notaRow.style.cssText = `color:var(--text-muted);font-size:0.85em;margin:1px 0;padding-left:${childIndentPx}px;`;
          // Show just the value part after "notas:: "
          const notaValue = nota.text.replace(/^notas::\s*/, "");
          const notaSpan = document.createElement("span");
          notaSpan.textContent = notaValue;
          notaSpan.style.cursor = "text";
          notaRow.appendChild(notaSpan);
          // Make notas editable
          this.makeSpanEditable(notaSpan, sourceLines, nota.sourceIdx, block, rendered);
        }

        // Add PM properties toggle button if this task has hidden props (read-only)
        if (v.hiddenProps.length > 0) {
          const toggleBtn = document.createElement("span");
          toggleBtn.className = "pm-toggle-btn";
          setIcon(toggleBtn, "sliders-horizontal");
          toggleBtn.setAttribute("aria-label", "Mostrar/ocultar propiedades PM");
          toggleBtn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:4px;cursor:pointer;color:var(--text-muted);opacity:0.6;margin-left:6px;vertical-align:middle;border:1px solid var(--background-modifier-border);background:var(--background-secondary);transition:all 0.15s;";
          row.appendChild(toggleBtn);

          const propsContainer = rendered.createDiv();
          propsContainer.style.cssText = `display:none;margin:2px 0;`;
          for (const prop of v.hiddenProps) {
            const propRow = propsContainer.createDiv();
            propRow.style.cssText = `color:var(--text-faint);font-size:0.8em;margin:1px 0;padding-left:${childIndentPx}px;`;
            propRow.textContent = prop.text;
          }
          rows.push({ el: propsContainer, indent: indent + 1 });

          toggleBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isHidden = propsContainer.style.display === "none";
            propsContainer.style.display = isHidden ? "" : "none";
            toggleBtn.classList.toggle("active", isHidden);
            if (isHidden) {
              toggleBtn.style.opacity = "1";
              toggleBtn.style.color = "var(--text-accent)";
              toggleBtn.style.borderColor = "var(--text-accent)";
            } else {
              toggleBtn.style.opacity = "0.6";
              toggleBtn.style.color = "var(--text-muted)";
              toggleBtn.style.borderColor = "var(--background-modifier-border)";
            }
          });
          toggleBtn.addEventListener("mouseenter", () => { toggleBtn.style.opacity = "1"; toggleBtn.style.background = "var(--background-modifier-border)"; });
          toggleBtn.addEventListener("mouseleave", () => { if (!toggleBtn.classList.contains("active")) { toggleBtn.style.opacity = "0.6"; toggleBtn.style.background = "var(--background-secondary)"; } });
        }
      } else {
        const textSpan = document.createElement("span");
        if (bulletMatch) {
          textSpan.innerHTML = "• " + renderInline(textContent);
        } else {
          textSpan.innerHTML = renderInline(textContent);
        }
        textSpan.style.cursor = "text";
        row.appendChild(textSpan);

        this.makeSpanEditable(textSpan, sourceLines, idx, block, rendered);
        this.attachLinkHandlers(textSpan, block);
      }
    }
  }

  /* ── Convert edited HTML back to markdown source ── */
  private htmlToMd(el: HTMLElement): string {
    let md = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        md += node.textContent || "";
      } else if (node instanceof HTMLElement) {
        const tag = node.tagName.toLowerCase();
        if (tag === "a" && node.classList.contains("internal-link")) {
          const href = node.getAttribute("data-href") || node.getAttribute("href") || "";
          const text = node.textContent || "";
          if (text === href || text === href.replace(/.*\//, "")) {
            md += `[[${href}]]`;
          } else {
            md += `[[${href}|${text}]]`;
          }
        } else if (tag === "strong" || tag === "b") {
          md += `**${this.htmlToMd(node)}**`;
        } else if (tag === "em" || tag === "i") {
          md += `*${this.htmlToMd(node)}*`;
        } else if (tag === "del" || tag === "s") {
          md += `~~${this.htmlToMd(node)}~~`;
        } else {
          md += this.htmlToMd(node);
        }
      }
    }
    return md;
  }

  /* ── Make a span editable on click (like client-outline) ── */
  private makeSpanEditable(span: HTMLElement, sourceLines: string[], lineIdx: number, block: BacklinkBlock, rendered: HTMLElement) {
    const startEdit = (e: MouseEvent, showSource: boolean) => {
      if (span.isContentEditable) return;
      e.stopPropagation();
      e.preventDefault();

      const origLine = sourceLines[lineIdx];
      const prefixMatch = origLine.match(/^(\s*[-*+]\s*(?:\[.\]\s*)?)/);
      const prefix = prefixMatch ? prefixMatch[1] : "";
      const textPart = origLine.substring(prefix.length);

      if (showSource) {
        // Show raw source (with [[brackets]], **bold**, etc.) for full editing
        span.textContent = textPart;
      }
      const originalText = span.textContent || "";
      const editingSource = showSource;

      span.contentEditable = "plaintext-only";
      span.style.outline = "none";
      span.focus();

      // Place cursor at click position
      try {
        const x = e.clientX, y = e.clientY;
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
        span.contentEditable = "false";

        let newContent: string;
        if (editingSource) {
          // Was editing raw source text, just use textContent
          newContent = (span.textContent?.trim() || "").replace(/^• /, "");
        } else {
          // Was editing rendered HTML, convert back to markdown
          newContent = this.htmlToMd(span).trim().replace(/^• /, "");
        }
        const cleanOrig = textPart.trim();

        if (save && newContent !== cleanOrig) {
          if (newContent === "") {
            sourceLines.splice(lineIdx, 1);
          } else {
            sourceLines[lineIdx] = prefix + newContent;
          }
          block.content = sourceLines.join("\n");
          await this.saveEdit(block, block.content);
        }
        this.renderLines(rendered, block);
      };

      span.addEventListener("blur", () => finish(true), { once: true });
      span.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); span.blur(); }
        if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    };

    // Click on regular text: edit inline (no visual changes)
    span.addEventListener("click", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("a")) return;
      startEdit(e, false);
    });

    // Click on link (via link-edit event): edit showing source with [[brackets]]
    span.addEventListener("link-edit", ((e: CustomEvent) => {
      startEdit(e.detail as MouseEvent, true);
    }) as EventListener);
  }

  private attachLinkHandlers(editableSpan: HTMLElement, block: BacklinkBlock) {
    editableSpan.querySelectorAll("a.internal-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const me = e as MouseEvent;

        if (me.ctrlKey || me.metaKey) {
          // Ctrl/Cmd+Click: navigate to link in new tab
          const href = link.getAttribute("href") || link.getAttribute("data-href") || "";
          if (href) this.app.workspace.openLinkText(href, block.sourceFile.path, true);
        } else {
          // Normal click on link: enter edit mode showing source with [[brackets]]
          editableSpan.dispatchEvent(new CustomEvent("link-edit", { detail: e }));
        }
      });
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

      // Find lines that link to the target file using two methods:
      // 1. metadataCache resolved links (handles all link forms)
      // 2. Text pattern fallback (handles aliases, cache timing)
      const sourceCache = this.app.metadataCache.getFileCache(sourceFile);
      const linkingLines = new Set<number>();

      // Method 1: metadataCache links with resolution
      if (sourceCache?.links) {
        for (const link of sourceCache.links) {
          const linkPath = link.link.split("|")[0].split("#")[0];
          const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
          if (resolved && resolved.path === file.path) {
            linkingLines.add(link.position.start.line);
          }
        }
      }

      // Method 2: text pattern search (always runs as complement)
      const patterns: string[] = [
        `[[${file.path}]]`, `[[${file.basename}]]`, `[[${file.basename}|`,
      ];
      const targetCache = this.app.metadataCache.getFileCache(file);
      const rawAliases = targetCache?.frontmatter?.aliases;
      const aliasList: string[] = rawAliases ? (Array.isArray(rawAliases) ? rawAliases.map(String) : [String(rawAliases)]) : [];
      for (const a of aliasList) {
        const clean = a.replace(/^\[\[.*\|?|\]\]$/g, "").trim();
        if (clean) { patterns.push(`[[${clean}]]`); patterns.push(`[[${clean}|`); }
      }
      for (let i = 0; i < lines.length; i++) {
        if (patterns.some((p) => lines[i].includes(p))) linkingLines.add(i);
      }

      for (let i = 0; i < lines.length; i++) {
        if (!linkingLines.has(i)) continue;
        const line = lines[i];

        const depth = this.getDepth(line);

        // Only capture the link line + its children (NOT siblings or parents)
        const startLine = i;
        let endLine = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "") { endLine = j - 1; break; }
          if (this.getDepth(lines[j]) <= depth) { endLine = j - 1; break; }
          endLine = j;
        }

        // Build breadcrumb: walk up to collect parent hierarchy
        const breadcrumb: string[] = [];
        if (depth > 0) {
          let currentDepth = depth;
          for (let j = i - 1; j >= 0; j--) {
            const parentTrimmed = lines[j].trim();
            if (!parentTrimmed) break;
            const parentDepth = this.getDepth(lines[j]);
            if (parentDepth < currentDepth) {
              // Extract text from parent line (strip bullet/task prefix)
              const parentText = parentTrimmed.replace(/^[-*+]\s+(\[.\]\s+)?/, "");
              breadcrumb.unshift(parentText);
              currentDepth = parentDepth;
              if (parentDepth === 0) break;
            }
          }
        }

        blocks.push({
          sourceFile,
          lineStart: startLine,
          lineEnd: endLine,
          content: lines.slice(startLine, endLine + 1).join("\n"),
          depth,
          breadcrumb,
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
    // Sort by file path, then by startLine
    const sorted = [...blocks].sort((a, b) => {
      if (a.sourceFile.path !== b.sourceFile.path) return a.sourceFile.path.localeCompare(b.sourceFile.path);
      return a.lineStart - b.lineStart;
    });

    // Merge overlapping or contained blocks from the same file
    const merged: BacklinkBlock[] = [];
    for (const block of sorted) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      if (prev && prev.sourceFile.path === block.sourceFile.path &&
          block.lineStart <= prev.lineEnd + 1) {
        // Overlapping or adjacent — extend prev to cover both
        if (block.lineEnd > prev.lineEnd) {
          const lines = block.content.split("\n");
          const extraLines = lines.slice(prev.lineEnd - block.lineStart + 1);
          if (extraLines.length > 0) {
            prev.content += "\n" + extraLines.join("\n");
          }
          prev.lineEnd = block.lineEnd;
        }
        // Keep the shorter breadcrumb (higher-level parent)
        if (block.breadcrumb.length < prev.breadcrumb.length) {
          prev.breadcrumb = block.breadcrumb;
        }
      } else {
        merged.push({ ...block });
      }
    }
    return merged;
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
