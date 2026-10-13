// Rich Telegram formatting with safe fallback
import { MAX_TELEGRAM_LENGTH } from "./config.js";
import { escapeHtml } from "./utils.js";

/**
 * Convert markdown-style tables to Unicode box-drawing
 */
export function formatTable(rows) {
  if (!rows || rows.length === 0) return "";

  // Find max width for each column
  const colWidths = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cellLen = String(row[i] || "").length;
      colWidths[i] = Math.max(colWidths[i] || 0, cellLen);
    }
  }

  // Build table with box-drawing characters
  const lines = [];
  
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = row.map((cell, i) => {
      return String(cell || "").padEnd(colWidths[i], " ");
    });
    
    if (r === 0) {
      // Header row
      lines.push("┌" + cells.map((c, i) => "─".repeat(colWidths[i] + 2)).join("┬") + "┐");
      lines.push("│ " + cells.join(" │ ") + " │");
      lines.push("├" + cells.map((c, i) => "─".repeat(colWidths[i] + 2)).join("┼") + "┤");
    } else {
      lines.push("│ " + cells.join(" │ ") + " │");
    }
  }
  
  lines.push("└" + colWidths.map(w => "─".repeat(w + 2)).join("┴") + "┘");
  
  return "<pre>" + escapeHtml(lines.join("\n")) + "</pre>";
}

/**
 * Format numbered or bulleted list
 */
export function formatList(items, numbered = false) {
  if (!items || items.length === 0) return "";

  const lines = items.map((item, i) => {
    const prefix = numbered ? `${i + 1}. ` : "• ";
    return prefix + String(item);
  });

  return lines.join("\n");
}

/**
 * Format code block with language
 */
export function formatCodeBlock(code, language = "") {
  const lang = language ? ` (${language})` : "";
  return "<pre><code" + (language ? ' class="language-' + escapeHtml(language) + '"' : "") + ">" + escapeHtml(code) + "</code></pre>";
}

/**
 * Format expandable quote block (Telegram Bot API 7.0+)
 */
export function formatExpandableQuote(text) {
  // Use expandable blockquote if text is long
  if (text.length > 200) {
    return '<blockquote expandable="true">' + escapeHtml(text) + "</blockquote>";
  }
  return "<blockquote>" + escapeHtml(text) + "</blockquote>";
}

/**
 * Enhance AI response with rich formatting
 * Detects code blocks, tables, lists and applies appropriate formatting
 */
export function enhanceFormatting(text) {
  let enhanced = text;

  // Detect and format code blocks
  enhanced = enhanced.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return formatCodeBlock(code.trim(), lang);
  });

  // Detect and format inline code
  enhanced = enhanced.replace(/`([^`]+)`/g, (match, code) => {
    return "<code>" + escapeHtml(code) + "</code>";
  });

  // Detect and format bold first (must precede italic)
  enhanced = enhanced.replace(/\*\*([^*]+)\*\*/g, (match, text) => {
    return "<b>" + escapeHtml(text) + "</b>";
  });

  // Detect and format italic (negative lookahead/behind to avoid matching **)
  enhanced = enhanced.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (match, text) => {
    return "<i>" + escapeHtml(text) + "</i>";
  });

  return enhanced;
}

/**
 * Safe format with fallback to plain text
 */
export function safeFormat(text, parseMode = "HTML") {
  if (parseMode !== "HTML") {
    return { text: text, parseMode: null };
  }

  try {
    const enhanced = enhanceFormatting(text);
    
    // Check if result is within Telegram limits
    if (enhanced.length > MAX_TELEGRAM_LENGTH) {
      return { text: text, parseMode: null };
    }

    return { text: enhanced, parseMode: "HTML" };
  } catch (err) {
    // Fallback to plain text on any error
    return { text: text, parseMode: null };
  }
}
