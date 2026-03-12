/**
 * Resolve Atelier API search matches to absolute 0-based line numbers.
 *
 * This logic is ported and adapted from vscode-objectscript's
 * `src/providers/FileSystemProvider/TextSearchProvider.ts` (the
 * `searchMatchToLine` / `descLineToDocLine` functions), which is the
 * battle-tested implementation maintained by the vscode-objectscript team.
 *
 * We cannot use their `TextSearchProvider` class directly because it
 * implements `vscode.TextSearchProvider` — a *proposed* VS Code API that
 * requires `enabledApiProposals` in package.json and only works in extension
 * development mode or with `--enable-proposed-api`.  Instead, we copy just
 * the pure line-resolving logic and call it from our own search panel.
 *
 * All credit for the resolution algorithm goes to the vscode-objectscript
 * contributors: https://github.com/intersystems-community/vscode-objectscript
 */

import type { ISearchMatch } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an `attrline` in a description block to a 0-based absolute line
 * number in the document.
 *
 * Description lines start with `///`.  We scan backwards from `memberLine`
 * to find where the description block begins, then add `attrline` (1-based)
 * to get the absolute position.
 */
function descLineToDocLine(content: string[], attrline: number, memberLine: number): number {
  let result = 0;
  for (let i = memberLine - 1; i >= 0; i--) {
    if (!content[i].startsWith('///')) {
      result = i;
      break;
    } else if (i === 0) {
      result = -1;
    }
  }
  return result + attrline;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an Atelier `/action/search` match to a 0-based absolute line number
 * within the document `content` (an array of lines split on `\r?\n`).
 *
 * Returns `null` when the line cannot be determined (e.g. member not found).
 *
 * @param content             Array of document lines
 * @param match               A single match from the Atelier search response
 * @param fileName            Full document name, e.g. `My.Pkg.Cls.cls`,
 *                            `MyRoutine.mac`, or `/csp/user/page.csp`
 * @param multilineMethodArgs Value of `objectscript.multilineMethodArgs` setting
 */
export function resolveMatchLine(
  content: string[],
  match: ISearchMatch,
  fileName: string,
  multilineMethodArgs: boolean,
): number | null {
  let line: number | null = match.line !== undefined ? Number(match.line) : null;

  if (match.member !== undefined) {
    // ── Inside a class member ────────────────────────────────────────────────

    if (match.member === 'Storage' && match.attr?.includes(',') && match.attrline === undefined) {
      // Storage XML path — walk the comma-separated tag chain
      const xmlTags = match.attr!.split(',');
      const storageRegex = new RegExp(`^Storage ${escapeRe(xmlTags[0])}`);
      let inStorage = false;
      for (let i = 0; i < content.length; i++) {
        if (!inStorage && content[i].match(storageRegex)) {
          inStorage = true;
          xmlTags.shift();
        }
        if (inStorage) {
          if (xmlTags.length > 0 && content[i].includes(xmlTags[0])) {
            xmlTags.shift();
          }
          if (xmlTags.length === 0 && content[i].includes(match.text)) {
            line = i;
            break;
          }
        }
      }
    } else if (match.attr === 'Content' && /^T\d+$/.test(match.member)) {
      // Non-description comment block (T1, T2, …)
      for (let i = 0; i < content.length; i++) {
        if (content[i].trimStart() === match.text) {
          line = i;
          break;
        }
      }
    } else {
      const memberMatchPattern = new RegExp(
        `^((?:Class|Client)?Method|Property|XData|Query|Trigger|Parameter|Relationship|Index|ForeignKey|Storage|Projection)\\s+${escapeRe(match.member)}`,
      );
      for (let i = 0; i < content.length; i++) {
        if (content[i].match(memberMatchPattern)) {
          // memend = index of the opening `{` line (or line after declaration
          // for single-line signatures without multi-line arg tracking enabled)
          let memend = i + 1;
          if (multilineMethodArgs && content[i].match(/^(?:Class|Client)?Method|Query /)) {
            for (let j = i + 1; j < content.length; j++) {
              if (content[j].trim() === '{') {
                memend = j;
                break;
              }
            }
          }

          if (match.attr === undefined) {
            if (match.line === undefined) {
              // Match is in the member declaration line itself
              line = i;
            } else {
              // Match is in the implementation body
              line = memend + Number(match.line);
            }
          } else {
            if (match.attr === 'Description') {
              line = descLineToDocLine(content, match.attrline!, i);
            } else if (
              match.attrline !== undefined ||
              ['Code', 'Data', 'SqlQuery'].includes(match.attr)
            ) {
              if (['Code', 'Data', 'SqlQuery'].includes(match.attr)) {
                // Implementation body (XData, Parameter value, Storage body)
                line = memend + (match.attrline ?? 1);
              } else {
                // Keyword with a multi-line value
                line = i + (match.attrline! - 1 || 0);
              }
            } else {
              // Match is inside the member definition (keyword search)
              for (let j = i; j < content.length; j++) {
                if (
                  content[j].includes(
                    // For Type/ReturnType we search for the actual text value
                    ['Type', 'ReturnType'].includes(match.attr) ? match.text : match.attr,
                  )
                ) {
                  line = j;
                  break;
                } else if (
                  j > i &&
                  /^((?:Class|Client)?Method|Property|XData|Query|Trigger|Parameter|Relationship|Index|ForeignKey|Storage|Projection|\/\/\/)/.test(
                    content[j],
                  )
                ) {
                  // Reached the start of the next member — stop searching
                  break;
                }
              }
            }
          }
          break;
        }
      }
    }
  } else if (match.attr !== undefined) {
    // ── Class-level attribute (no member) ────────────────────────────────────

    if (match.attr === 'IncludeCode') {
      for (let i = 0; i < content.length; i++) {
        if (content[i].match(/^Include /)) {
          line = i;
          break;
        }
      }
    } else if (match.attr === 'IncludeGenerator') {
      for (let i = 0; i < content.length; i++) {
        if (content[i].match(/^IncludeGenerator/)) {
          line = i;
          break;
        }
      }
    } else if (match.attr === 'Import') {
      for (let i = 0; i < content.length; i++) {
        if (content[i].match(/^Import/)) {
          line = i;
          break;
        }
      }
    } else if (match.attr === 'Copyright') {
      line = (match.attrline ?? 1) - 1;
    } else {
      // Match is in the class definition line or a class-level keyword
      const classMatchPattern = new RegExp(`^Class ${escapeRe(fileName.slice(0, -4))}`);
      let keywordSearch = false;
      for (let i = 0; i < content.length; i++) {
        if (content[i].match(classMatchPattern)) {
          if (match.attr === 'Description') {
            line = descLineToDocLine(content, match.attrline!, i);
            break;
          } else if (match.attr === 'Super' || match.attr === 'Name') {
            if (content[i].includes(match.text)) {
              line = i;
            }
            break;
          } else {
            // Class keyword — need to keep looping past the Class line
            keywordSearch = true;
          }
        }
        if (keywordSearch) {
          if (content[i].includes(match.attr)) {
            line = match.attrline ? i + match.attrline - 1 : i;
            break;
          } else if (
            /^((?:Class|Client)?Method|Property|XData|Query|Trigger|Parameter|Relationship|Index|ForeignKey|Storage|Projection|\/\/\/)/.test(
              content[i],
            )
          ) {
            // Reached the first member — keyword not found
            break;
          }
        }
      }
    }
  } else if (line === null && match.text === fileName) {
    // Match is in the routine / document header
    line = 0;
  }

  // CSP files (contain '/' in their name) use 1-based line numbers from the
  // API, so subtract 1 to convert to 0-based.  All other documents produce
  // 0-based values through the arithmetic above.
  return typeof line === 'number' ? (fileName.includes('/') ? line - 1 : line) : null;
}
