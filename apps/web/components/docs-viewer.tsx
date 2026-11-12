"use client";

import Link from "next/link";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { USER_GUIDE_MARKDOWN } from "../lib/docs-content";
import { TwoLayerNavbar } from "./brand-logo";

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: { text: string; children: string[] }[] }
  | { type: "table"; headers: string[]; rows: string[][] };

function slugify(text: string, index: number) {
  const clean = text
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean || "section"}-${index}`;
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let i = 0;

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", text: para.join(" ") });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      flushPara();
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (!trimmed) {
      flushPara();
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushPara();
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      const text = headingMatch[2].trim();
      blocks.push({ type: "heading", level, text, id: slugify(text, blocks.length) });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushPara();
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join(" ") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:\-|]+\|[\s:\-|]*$/.test(lines[i + 1])) {
      flushPara();
      const splitRow = (row: string) => {
        let value = row.trim();
        if (value.startsWith("|")) value = value.slice(1);
        if (value.endsWith("|")) value = value.slice(0, -1);
        return value.split("|").map((cell) => cell.trim());
      };
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushPara();
      const baseIndent = listMatch[1].length;
      const ordered = listMatch[2].endsWith(".");
      const items: { text: string; children: string[] }[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = cur.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m && m[1].length >= baseIndent) {
          if (m[1].length > baseIndent && items.length > 0) {
            items[items.length - 1].children.push(m[3].trim());
          } else {
            items.push({ text: m[3].trim(), children: [] });
          }
          i += 1;
        } else if (cur.trim() === "") {
          if (i + 1 < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i + 1])) {
            i += 1;
            continue;
          }
          break;
        } else if (cur.startsWith("  ") && items.length > 0) {
          items[items.length - 1].text += ` ${cur.trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    para.push(trimmed);
    i += 1;
  }

  flushPara();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
      return <code key={idx}>{token.slice(1, -1)}</code>;
    }
    const parts: ReactNode[] = [];
    const pattern = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(token)) !== null) {
      if (match.index > last) {
        parts.push(token.slice(last, match.index));
      }
      if (match[2]) {
        parts.push(<strong key={`${idx}-${match.index}`}>{match[2]}</strong>);
      } else if (match[3]) {
        parts.push(<em key={`${idx}-${match.index}`}>{match[3]}</em>);
      }
      last = pattern.lastIndex;
    }
    if (last < token.length) {
      parts.push(token.slice(last));
    }
    return <Fragment key={idx}>{parts}</Fragment>;
  });
}

export function DocsViewer() {
  const [query, setQuery] = useState("");
  const blocks = useMemo(() => parseMarkdown(USER_GUIDE_MARKDOWN), []);
  const toc = useMemo(
    () => blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && b.level === 2),
    [blocks]
  );

  const normalizedQuery = query.trim().toLowerCase();
  const matchingToc = useMemo(() => {
    if (!normalizedQuery) return toc;
    return toc.filter((item) => item.text.toLowerCase().includes(normalizedQuery));
  }, [toc, normalizedQuery]);

  const filteredBlocks = useMemo(() => {
    if (!normalizedQuery) return blocks;
    const out: Block[] = [];
    let currentHeading: Extract<Block, { type: "heading" }> | null = null;
    let headingEmitted = false;
    for (const block of blocks) {
      if (block.type === "heading") {
        if (block.level === 1) {
          out.push(block);
          continue;
        }
        currentHeading = block;
        headingEmitted = false;
        if (block.text.toLowerCase().includes(normalizedQuery)) {
          out.push(block);
          headingEmitted = true;
        }
        continue;
      }
      if (block.type === "hr") continue;
      const haystack =
        block.type === "table"
          ? `${block.headers.join(" ")} ${block.rows.flat().join(" ")}`
          : block.type === "list"
            ? block.items.map((item) => `${item.text} ${item.children.join(" ")}`).join(" ")
            : block.text;
      if (haystack.toLowerCase().includes(normalizedQuery) || (currentHeading && currentHeading.text.toLowerCase().includes(normalizedQuery))) {
        if (currentHeading && !headingEmitted) {
          out.push(currentHeading);
          headingEmitted = true;
        }
        out.push(block);
      }
    }
    return out;
  }, [blocks, normalizedQuery]);

  return (
    <main className="dashboard-shell docs-shell">
      <TwoLayerNavbar>
        <Link className="text-button" href="/">Home</Link>
        <Link className="text-button" href="/dashboard">Dashboard</Link>
        <Link className="text-button" href="/complaints">Complaints</Link>
        <Link className="text-button" href="/pricing">Pricing</Link>
        <Link className="text-button" href="/login">Sign in</Link>
        <a
          className="primary-link"
          style={{ padding: "8px 14px", fontSize: "0.84rem" }}
          href="/docs/NomaanOS_User_Guide.pdf"
          download="NomaanOS_User_Guide.pdf"
        >
          Download User Guide PDF ↗
        </a>
      </TwoLayerNavbar>

      <section className="dashboard-content docs-container">
        <header className="docs-header">
          <div>
            <p className="eyebrow">USER GUIDE</p>
            <h1>NomaanOS User Guide</h1>
            <p className="dashboard-intro">
              Step-by-step instructions to help you set up your workspace, manage customer complaints, review AI insights, track analytics, and share complaint forms.
            </p>
          </div>
          <div className="docs-search-wrap">
            <label className="visually-hidden" htmlFor="docs-search">Search user guide</label>
            <input
              id="docs-search"
              type="search"
              className="docs-search-input"
              placeholder="Search user guide…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </header>

        <div className="docs-layout">
          <aside className="workspace-panel docs-sidebar" aria-label="Contents">
            <div className="panel-head">
              <h2>Contents</h2>
              <span>{matchingToc.length}</span>
            </div>
            {matchingToc.length === 0 ? (
              <p className="empty-state" style={{ padding: "12px 0", textAlign: "left" }}>No matching chapters.</p>
            ) : (
              <nav className="docs-toc">
                {matchingToc.map((item) => (
                  <a key={item.id} href={`#${item.id}`} className={`docs-toc-link level-${item.level}`}>
                    {item.text.replace(/`([^`]+)`/g, "$1")}
                  </a>
                ))}
              </nav>
            )}
          </aside>

          <article className="workspace-panel docs-article">
            {filteredBlocks.length === 0 ? (
              <div className="empty-state">
                <p>No sections matched “{query}”.</p>
                <button type="button" className="filter-button" style={{ marginTop: "12px" }} onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            ) : (
              filteredBlocks.map((block, index) => {
                if (block.type === "heading") {
                  if (block.level === 1) return <h1 key={index} id={block.id} className="docs-h1">{renderInline(block.text)}</h1>;
                  if (block.level === 2) return <h2 key={index} id={block.id} className="docs-h2">{renderInline(block.text)}</h2>;
                  if (block.level === 3) return <h3 key={index} id={block.id} className="docs-h3">{renderInline(block.text)}</h3>;
                  return <h4 key={index} id={block.id} className="docs-h4">{renderInline(block.text)}</h4>;
                }
                if (block.type === "hr") return <hr key={index} className="docs-hr" />;
                if (block.type === "paragraph") return <p key={index} className="docs-p">{renderInline(block.text)}</p>;
                if (block.type === "blockquote") return <blockquote key={index} className="docs-callout">{renderInline(block.text)}</blockquote>;
                if (block.type === "list") {
                  const Tag = block.ordered ? "ol" : "ul";
                  return (
                    <Tag key={index} className="docs-list">
                      {block.items.map((item, idx) => (
                        <li key={idx}>
                          {renderInline(item.text)}
                          {item.children.length > 0 && (
                            <ul>
                              {item.children.map((sub, sidx) => (
                                <li key={sidx}>{renderInline(sub)}</li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </Tag>
                  );
                }
                return (
                  <div key={index} className="docs-table-wrap">
                    <table className="docs-table">
                      <thead>
                        <tr>
                          {block.headers.map((header, hidx) => (
                            <th key={hidx}>{renderInline(header)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {block.rows.map((row, ridx) => (
                          <tr key={ridx}>
                            {block.headers.map((_, cidx) => (
                              <td key={cidx}>{renderInline(row[cidx] ?? "")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })
            )}
          </article>
        </div>
      </section>
    </main>
  );
}
