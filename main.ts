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
      || view.containerEl.querySelector(".cm-scroller");
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
        this.app.workspace.openLinkText(sourceFile.path, "", false);
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
    const renderContent = block.content.replace(/\t/g, "  ");
    const rendered = blockEl.createDiv({ cls: "eb-rendered" });
    await MarkdownRenderer.render(
      this.app,
      renderContent,
      rendered,
      block.sourceFile.path,
      this.renderComponent
    );

    this.attachLinkHandlers(rendered, block);

    // Get original plain text for diff comparison
    const originalPlainText = rendered.textContent || "";

    const startEdit = (e: MouseEvent) => {
      if (rendered.hasAttribute("data-eb-editing")) return;

      const target = e.target as HTMLElement;
      if (target.closest("a")) return;

      const originalHTML = rendered.innerHTML;
      rendered.setAttribute("data-eb-editing", "true");
      rendered.setAttribute("contenteditable", "true");

      // Store link data for expand/collapse
      const links = rendered.querySelectorAll("a.internal-link");
      const linkMap = new Map<HTMLElement, { href: string; text: string; expanded: boolean }>();
      links.forEach((a) => {
        const el = a as HTMLElement;
        const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
        const text = el.textContent || "";
        linkMap.set(el, { href, text, expanded: false });
      });

      // Expand link to [[markdown]] when cursor is on/near it
      const expandLink = (linkEl: HTMLElement) => {
        const data = linkMap.get(linkEl);
        if (!data || data.expanded) return;
        data.expanded = true;
        const md = data.text === data.href ? `[[${data.href}]]` : `[[${data.href}|${data.text}]]`;
        linkEl.textContent = md;
        linkEl.style.color = "var(--text-normal)";
        linkEl.style.textDecoration = "none";
        linkEl.style.fontWeight = "normal";
      };

      // Collapse link back to rendered
      const collapseLink = (linkEl: HTMLElement) => {
        const data = linkMap.get(linkEl);
        if (!data || !data.expanded) return;
        data.expanded = false;
        linkEl.textContent = data.text;
        linkEl.style.color = "";
        linkEl.style.textDecoration = "";
        linkEl.style.fontWeight = "";
      };

      // Monitor cursor position to expand/collapse links
      const checkCursor = () => {
        if (!rendered.hasAttribute("data-eb-editing")) return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const cursorNode = sel.focusNode;

        linkMap.forEach((data, linkEl) => {
          if (linkEl.contains(cursorNode) || linkEl === cursorNode) {
            expandLink(linkEl);
          } else {
            collapseLink(linkEl);
          }
        });
      };

      rendered.addEventListener("keyup", checkCursor);
      rendered.addEventListener("click", () => setTimeout(checkCursor, 10));
      // Initial check
      setTimeout(checkCursor, 50);

      // Place cursor exactly where clicked
      const sel = window.getSelection();
      if (sel && document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      setTimeout(checkCursor, 50);

      let finished = false;
      const finish = async (save: boolean) => {
        if (finished) return;
        finished = true;

        // Collapse all links before reading text
        linkMap.forEach((data, linkEl) => collapseLink(linkEl));

        const editedPlainText = rendered.textContent || "";
        rendered.removeAttribute("contenteditable");
        rendered.removeAttribute("data-eb-editing");
        rendered.removeEventListener("keyup", checkCursor);

        if (save && editedPlainText !== originalPlainText) {
          const newContent = this.applyTextDiff(block.content, originalPlainText, editedPlainText);
          await this.saveEdit(block, newContent);
          block.content = newContent;
          const newRenderContent = newContent.replace(/\t/g, "  ");
          rendered.empty();
          await MarkdownRenderer.render(this.app, newRenderContent, rendered, block.sourceFile.path, this.renderComponent);
          this.attachLinkHandlers(rendered, block);
        } else {
          rendered.innerHTML = originalHTML;
          this.attachLinkHandlers(rendered, block);
        }
      };

      rendered.addEventListener("blur", () => finish(true), { once: true });
      rendered.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    };

    // Click on non-link text = edit
    rendered.addEventListener("click", (e) => startEdit(e));

    // Double click anywhere (including links) = edit
    rendered.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Force edit even on links
      if (rendered.hasAttribute("data-eb-editing")) return;
      const originalHTML = rendered.innerHTML;
      rendered.setAttribute("data-eb-editing", "true");
      rendered.setAttribute("contenteditable", "true");
      const sel = window.getSelection();
      if (sel && document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (range) { sel.removeAllRanges(); sel.addRange(range); }
      }

      let finished = false;
      const finish = async (save: boolean) => {
        if (finished) return;
        finished = true;
        const editedPlainText = rendered.textContent || "";
        rendered.removeAttribute("contenteditable");
        rendered.removeAttribute("data-eb-editing");
        if (save && editedPlainText !== originalPlainText) {
          const newContent = this.applyTextDiff(block.content, originalPlainText, editedPlainText);
          await this.saveEdit(block, newContent);
          block.content = newContent;
          rendered.empty();
          await MarkdownRenderer.render(this.app, newContent.replace(/\t/g, "  "), rendered, block.sourceFile.path, this.renderComponent);
          this.attachLinkHandlers(rendered, block);
        } else {
          rendered.innerHTML = originalHTML;
          this.attachLinkHandlers(rendered, block);
        }
      };
      rendered.addEventListener("blur", () => finish(true), { once: true });
      rendered.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      });
    });
  }

  private getDirectText(el: HTMLElement): string {
    let text = "";
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || "";
      } else if (node instanceof HTMLElement && !node.matches("ul, ol")) {
        text += node.textContent || "";
      }
    }
    return text.trimEnd();
  }

  private applyTextDiff(originalMd: string, originalPlain: string, editedPlain: string): string {
    if (originalPlain === editedPlain) return originalMd;

    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < originalPlain.length && prefixLen < editedPlain.length
           && originalPlain[prefixLen] === editedPlain[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix
    let suffixLen = 0;
    while (suffixLen < (originalPlain.length - prefixLen)
           && suffixLen < (editedPlain.length - prefixLen)
           && originalPlain[originalPlain.length - 1 - suffixLen] === editedPlain[editedPlain.length - 1 - suffixLen]) {
      suffixLen++;
    }

    // Map plain text positions to markdown positions
    const mdPrefixPos = this.plainPosToMdPos(originalMd, originalPlain, prefixLen);
    const mdSuffixPos = suffixLen > 0
      ? this.plainPosToMdPos(originalMd, originalPlain, originalPlain.length - suffixLen)
      : originalMd.length;

    // The changed portion in edited text
    const editedMiddle = editedPlain.substring(prefixLen, editedPlain.length - suffixLen);

    // Reconstruct: markdown prefix + edited middle + markdown suffix
    return originalMd.substring(0, mdPrefixPos) + editedMiddle + originalMd.substring(mdSuffixPos);
  }

  private plainPosToMdPos(md: string, plain: string, plainPos: number): number {
    // Walk through markdown and plain text simultaneously to map position
    let pi = 0; // plain index
    let mi = 0; // markdown index

    while (mi < md.length && pi < plainPos) {
      // Skip markdown syntax that doesn't appear in plain text
      if (md.substring(mi).match(/^\[\[([^\]|]+)(\|([^\]]+))?\]\]/)) {
        const match = md.substring(mi).match(/^\[\[([^\]|]+)(\|([^\]]+))?\]\]/)!;
        const displayText = match[3] || match[1];
        const plainChars = displayText.length;
        const mdChars = match[0].length;
        if (pi + plainChars <= plainPos) {
          pi += plainChars;
          mi += mdChars;
        } else {
          // Position is inside a link — place cursor at start of link in md
          return mi;
        }
      } else if (md.substring(mi, mi + 2) === "**") {
        mi += 2; // skip **
      } else if (md[mi] === "*" && md.substring(mi, mi + 2) !== "**") {
        mi += 1; // skip *
      } else if (md.substring(mi, mi + 2) === "~~") {
        mi += 2;
      } else if (md[mi] === "`") {
        mi += 1;
      } else {
        pi++;
        mi++;
      }
    }
    return mi;
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
        if (href) this.app.workspace.openLinkText(href, block.sourceFile.path, false);
      });
    });
    container.querySelectorAll("a.external-link").forEach((link) => {
      link.addEventListener("click", (e) => { e.stopPropagation(); });
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
