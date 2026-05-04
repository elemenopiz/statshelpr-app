/**
 * Tiny markdown → DOM renderer (no innerHTML, no dependencies).
 * Supports: headings, paragraphs, bold, italic, inline code, code blocks
 * (with R syntax highlighting), bullet & numbered lists.
 *
 * Intentionally a SUBSET — Claude's answers don't need full CommonMark.
 */

export function renderMarkdown(md: string, root: HTMLElement) {
  const blocks = splitIntoBlocks(md);
  for (const block of blocks) renderBlock(block, root);
}

function splitIntoBlocks(md: string): string[][] {
  const lines = md.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];
  let inCode = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("```")) {
      if (inCode) {
        current.push(line);
        blocks.push(current);
        current = [];
        inCode = false;
      } else {
        if (current.length) {
          blocks.push(current);
          current = [];
        }
        current.push(line);
        inCode = true;
      }
    } else if (!inCode && line.trim() === "") {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function renderBlock(block: string[], root: HTMLElement) {
  const first = block[0] ?? "";

  // Fenced code block
  if (first.startsWith("```")) {
    const lang = first.slice(3).trim().toLowerCase();
    const last = block[block.length - 1] ?? "";
    const endIdx = last.startsWith("```") ? -1 : undefined;
    const code = block.slice(1, endIdx).join("\n");
    const pre = document.createElement("pre");
    pre.className = "md-code";
    if (lang === "r") highlightR(code, pre);
    else pre.textContent = code;
    root.appendChild(pre);
    return;
  }

  // Heading
  const h = first.match(/^(#{1,6})\s+(.*)$/);
  if (h && h[1] && h[2]) {
    const level = h[1].length;
    const tag = (`h${Math.min(level, 6)}`) as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
    const node = document.createElement(tag);
    renderInline(h[2], node);
    root.appendChild(node);
    return;
  }

  // Bullet list
  if (/^\s*[-*]\s+/.test(first)) {
    const ul = document.createElement("ul");
    for (const line of block) {
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m && m[1]) {
        const li = document.createElement("li");
        renderInline(m[1], li);
        ul.appendChild(li);
      }
    }
    root.appendChild(ul);
    return;
  }

  // Numbered list
  if (/^\s*\d+\.\s+/.test(first)) {
    const ol = document.createElement("ol");
    for (const line of block) {
      const m = line.match(/^\s*\d+\.\s+(.*)$/);
      if (m && m[1]) {
        const li = document.createElement("li");
        renderInline(m[1], li);
        ol.appendChild(li);
      }
    }
    root.appendChild(ol);
    return;
  }

  // Paragraph
  const p = document.createElement("p");
  renderInline(block.join(" "), p);
  root.appendChild(p);
}

function renderInline(text: string, root: HTMLElement) {
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      root.appendChild(document.createTextNode(text.slice(last, idx)));
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      const node = document.createElement("strong");
      node.textContent = tok.slice(2, -2);
      root.appendChild(node);
    } else if (tok.startsWith("`")) {
      const node = document.createElement("code");
      node.textContent = tok.slice(1, -1);
      root.appendChild(node);
    } else {
      const node = document.createElement("em");
      node.textContent = tok.slice(1, -1);
      root.appendChild(node);
    }
    last = idx + tok.length;
  }
  if (last < text.length) {
    root.appendChild(document.createTextNode(text.slice(last)));
  }
}

// =============================================================================
// R syntax highlighter (token-based, regex, no deps)
// =============================================================================

const R_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "repeat",
  "function",
  "return",
  "break",
  "next",
  "in",
  "TRUE",
  "FALSE",
  "T",
  "F",
  "NULL",
  "NA",
  "NA_integer_",
  "NA_real_",
  "NA_character_",
  "NaN",
  "Inf",
]);

interface RTokenSpec {
  re: RegExp;
  cls?: string;
}

const R_TOKEN_SPECS: RTokenSpec[] = [
  { re: /^#[^\n]*/, cls: "comment" },
  { re: /^"(?:[^"\\]|\\.)*"/, cls: "string" },
  { re: /^'(?:[^'\\]|\\.)*'/, cls: "string" },
  { re: /^\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[Li]?\b/, cls: "number" },
  { re: /^[a-zA-Z_.][\w.]*(?=\s*\()/, cls: "fn" },
  { re: /^[a-zA-Z_.][\w.]*/, cls: "ident" },
  { re: /^(?:<-|->|<<-|->>|%[^%]*%|::|:::|==|!=|<=|>=|&&|\|\||[+\-*/^<>=!&|~])/, cls: "op" },
  { re: /^[\s\n\r\t]+/ },
  { re: /^./ },
];

function highlightR(code: string, root: HTMLElement) {
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    let matched = false;
    for (const tok of R_TOKEN_SPECS) {
      const m = rest.match(tok.re);
      if (!m) continue;
      const text = m[0];
      let cls = tok.cls;
      if (cls === "ident" && R_KEYWORDS.has(text)) cls = "keyword";
      if (cls) {
        const span = document.createElement("span");
        span.className = `r-${cls}`;
        span.textContent = text;
        root.appendChild(span);
      } else {
        root.appendChild(document.createTextNode(text));
      }
      i += text.length;
      matched = true;
      break;
    }
    if (!matched) i += 1;
  }
}
