'use strict';

/** Escapes a string for use inside a RegExp. */
function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the value of `key` under `[section]`, or null.
 * Matching is case-insensitive. Commented lines (starting with ; or #) are ignored.
 */
function getIniValue(content, section, key) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const keyPat  = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');
  let inSection = false;
  for (const line of lines) {
    if (/^\s*[;#]/.test(line)) continue;
    if (/^\s*\[/.test(line) && !/^\s*[;#]/.test(line)) {
      inSection = secPat.test(line);
      continue;
    }
    if (inSection && keyPat.test(line)) {
      return line.slice(line.indexOf('=') + 1).trim();
    }
  }
  return null;
}

/**
 * Returns new INI content with `[section] key = value` set, preserving all
 * other lines, comments, and spacing style.
 */
function setIniValue(content, section, key, value) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const keyPat  = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');

  let inSection    = false;
  let sectionFound = false;
  let keyReplaced  = false;
  let insertPos    = -1;

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i];
    const isComment = /^\s*[;#]/.test(line);
    const isHeader  = !isComment && /^\s*\[/.test(line);

    if (isHeader) {
      if (inSection && !keyReplaced) {
        lines.splice(i, 0, key + ' = ' + value);
        keyReplaced = true;
        break;
      }
      inSection = secPat.test(line);
      if (inSection) { sectionFound = true; insertPos = i; }
      continue;
    }

    if (inSection) {
      insertPos = i;
      if (!isComment && keyPat.test(line)) {
        const eqIdx      = line.indexOf('=');
        const before     = line.slice(0, eqIdx);
        const spaceAfter = (eqIdx + 1 < line.length && line[eqIdx + 1] === ' ') ? ' ' : '';
        lines[i]    = before + '=' + spaceAfter + value;
        keyReplaced = true;
        break;
      }
    }
  }

  if (!keyReplaced) {
    if (sectionFound) {
      lines.splice(insertPos + 1, 0, key + ' = ' + value);
    } else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', '[' + section + ']', key + ' = ' + value);
    }
  }

  return lines.join('\n');
}

/**
 * Returns an array of values from every `+<key> = <value>` line under [section].
 */
function getIniListValues(content, section, key) {
  const lines   = content.split(/\r?\n/);
  const secPat  = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const addPat  = new RegExp('^\\s*\\+\\s*' + escRegex(key) + '\\s*=(.*)', 'i');
  let inSection = false;
  const result  = [];
  for (const line of lines) {
    if (/^\s*[;#]/.test(line)) continue;
    if (/^\s*\[/.test(line)) { inSection = secPat.test(line); continue; }
    if (inSection) {
      const m = line.match(addPat);
      if (m) result.push(m[1].trim());
    }
  }
  return result;
}

/**
 * Returns new INI content where ALL existing `+<key>` and `-<key>` lines under
 * [section] are replaced with one `+<key> = <value>` line per entry in valuesArray.
 */
function setIniListValues(content, section, key, valuesArray) {
  const lines      = content.split(/\r?\n/);
  const secPat     = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  const listKeyPat = new RegExp('^\\s*[+-]\\s*' + escRegex(key) + '\\s*=', 'i');

  let inSection       = false;
  let sectionFound    = false;
  let sectionEndIdx   = -1;
  let lastContentIdx  = -1;
  const filtered      = [];

  for (let i = 0; i < lines.length; i++) {
    const line      = lines[i];
    const isComment = /^\s*[;#]/.test(line);
    const isHeader  = !isComment && /^\s*\[/.test(line);

    if (isHeader) {
      if (inSection) {
        sectionEndIdx = lastContentIdx >= 0 ? lastContentIdx + 1 : filtered.length;
      }
      inSection = secPat.test(line);
      if (inSection) { sectionFound = true; lastContentIdx = -1; }
      filtered.push(line);
      continue;
    }

    if (inSection && !isComment && listKeyPat.test(line)) continue;

    if (inSection && line.trim() !== '') lastContentIdx = filtered.length;
    filtered.push(line);
  }

  if (inSection) {
    sectionEndIdx = lastContentIdx >= 0 ? lastContentIdx + 1 : filtered.length;
  }

  if (sectionFound) {
    filtered.splice(sectionEndIdx, 0, ...valuesArray.map(v => '+' + key + ' = ' + v));
  } else if (valuesArray.length > 0) {
    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
    filtered.push('', '[' + section + ']');
    for (const v of valuesArray) filtered.push('+' + key + ' = ' + v);
  }

  return filtered.join('\n');
}

module.exports = { getIniValue, setIniValue, getIniListValues, setIniListValues };
