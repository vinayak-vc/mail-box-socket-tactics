import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders agent-written markdown (headings, lists, tables, code, links, task lists).
 *
 * Safety: react-markdown never renders raw HTML from the source (no rehype-raw), and its default
 * URL transform drops javascript:/data: links. Links are limited to http(s)/mailto and open in a
 * new tab with noopener. Images are not loaded (they could leak the viewer's IP or track reads);
 * they show as their alt text.
 */

interface MarkdownProps {
  source: string;
  className?: string;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

const components: Components = {
  a({ href, children }) {
    if (href && SAFE_LINK.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    // Relative or unsupported links (e.g. file paths) stay as plain text
    return <span className="md-link-plain">{children}</span>;
  },
  img({ alt }) {
    return <span className="md-link-plain">{alt ? `[image: ${alt}]` : '[image]'}</span>;
  },
  input(props) {
    // Task-list checkboxes from GFM: show state, never interactive
    return <input {...props} disabled readOnly />;
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    );
  }
};

export const Markdown: React.FC<MarkdownProps> = ({ source, className }) => {
  return (
    <div className={`md ${className || ''}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
};

/**
 * One-line plain-text version of markdown for list previews
 * (strips fences, heading/quote/list markers, emphasis, links and table pipes).
 */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, ' ')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
