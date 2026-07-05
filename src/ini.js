'use strict';

/** Escapes a string for use inside a RegExp. */
function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips a trailing `; comment` or `# comment` from a raw INI value. */
function stripInlineComment(value) {
  return value.replace(/[;#].*$/, '').trim();
}

/**
 * Scans `lines` once and classifies each one (comment / header / in-section
 * content) with a single, shared definition of "inside [section]" — matching
 * is case-insensitive, and if the same section name appears more than once
 * all of its occurrences are treated as one logical section (so a key can be
 * found in one occurrence and a later occurrence still gets scanned too).
 * Every reader and writer below shares this exact definition, so a read and a
 * subsequent write always agree on which line owns a key.
 */
function scanLines(lines, section) {
  const secPat = new RegExp('^\\s*\\[' + escRegex(section) + '\\]\\s*$', 'i');
  let inSection   = false;
  let sectionSeen = false;
  const flags = lines.map((line) => {
    const isComment = /^\s*[;#]/.test(line);
    const isHeader  = !isComment && /^\s*\[/.test(line);
    if (isHeader) {
      const entersSection = secPat.test(line);
      inSection = entersSection;
      if (inSection) sectionSeen = true;
      return { line, isComment, isHeader, inSection: false, entersSection };
    }
    return { line, isComment, isHeader, inSection, entersSection: false };
  });
  return { flags, sectionSeen };
}

/**
 * Returns the value of `key` under `[section]`, or null.
 * Matching is case-insensitive. Commented lines (starting with ; or #) are ignored.
 */
function getIniValue(content, section, key) {
  const lines      = content.split(/\r?\n/);
  const { flags }  = scanLines(lines, section);
  const keyPat     = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');
  for (let i = 0; i < lines.length; i++) {
    const f = flags[i];
    if (f.inSection && !f.isComment && keyPat.test(f.line)) {
      return stripInlineComment(f.line.slice(f.line.indexOf('=') + 1));
    }
  }
  return null;
}

/**
 * Returns new INI content with `[section] key = value` set, preserving all
 * other lines, comments, and spacing style.
 */
function setIniValue(content, section, key, value) {
  const lines = content.split(/\r?\n/);
  const { flags, sectionSeen } = scanLines(lines, section);
  const keyPat = new RegExp('^\\s*' + escRegex(key) + '\\s*=', 'i');

  let replaceIdx     = -1;
  let lastContentIdx = -1;
  let lastHeaderIdx  = -1;
  for (let i = 0; i < lines.length; i++) {
    if (flags[i].entersSection) lastHeaderIdx = i;
    if (flags[i].inSection) {
      lastContentIdx = i;
      if (replaceIdx === -1 && !flags[i].isComment && keyPat.test(lines[i])) replaceIdx = i;
    }
  }

  if (replaceIdx !== -1) {
    const line       = lines[replaceIdx];
    const eqIdx      = line.indexOf('=');
    const before     = line.slice(0, eqIdx);
    const spaceAfter = (eqIdx + 1 < line.length && line[eqIdx + 1] === ' ') ? ' ' : '';
    lines[replaceIdx] = before + '=' + spaceAfter + value;
    return lines.join('\n');
  }

  if (sectionSeen) {
    const insertAt = lastContentIdx >= 0 ? lastContentIdx + 1 : lastHeaderIdx + 1;
    lines.splice(insertAt, 0, key + ' = ' + value);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', '[' + section + ']', key + ' = ' + value);
  }

  return lines.join('\n');
}

/**
 * Returns an array of values from every `+<key> = <value>` line under [section].
 */
function getIniListValues(content, section, key) {
  const lines     = content.split(/\r?\n/);
  const { flags } = scanLines(lines, section);
  const addPat     = new RegExp('^\\s*\\+\\s*' + escRegex(key) + '\\s*=(.*)', 'i');
  const result     = [];
  for (let i = 0; i < lines.length; i++) {
    const f = flags[i];
    if (f.inSection && !f.isComment) {
      const m = f.line.match(addPat);
      if (m) result.push(stripInlineComment(m[1]));
    }
  }
  return result;
}

/**
 * Returns new INI content where existing `+<key>` lines under [section] are
 * replaced with one `+<key> = <value>` line per entry in valuesArray. Existing
 * `-<key>` lines (user/tool-added overrides) are left untouched — this function
 * only owns the `+<key>` lines it round-trips via getIniListValues.
 */
function setIniListValues(content, section, key, valuesArray) {
  const lines = content.split(/\r?\n/);
  const { flags, sectionSeen } = scanLines(lines, section);
  const listKeyPat = new RegExp('^\\s*\\+\\s*' + escRegex(key) + '\\s*=', 'i');

  let lastContentIdx       = -1; // filtered-space index of last in-section content line kept
  let lastHeaderFilteredIdx = -1; // filtered-space index of the most recent header entering the section
  const filtered = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f    = flags[i];

    if (f.isHeader) {
      filtered.push(line);
      if (f.entersSection) lastHeaderFilteredIdx = filtered.length - 1;
      continue;
    }

    if (f.inSection && !f.isComment && listKeyPat.test(line)) continue;

    if (f.inSection && line.trim() !== '') lastContentIdx = filtered.length;
    filtered.push(line);
  }

  if (sectionSeen) {
    const insertAt = lastContentIdx >= 0 ? lastContentIdx + 1 : lastHeaderFilteredIdx + 1;
    filtered.splice(insertAt, 0, ...valuesArray.map(v => '+' + key + ' = ' + v));
  } else if (valuesArray.length > 0) {
    while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') filtered.pop();
    filtered.push('', '[' + section + ']');
    for (const v of valuesArray) filtered.push('+' + key + ' = ' + v);
  }

  return filtered.join('\n');
}

module.exports = { getIniValue, setIniValue, getIniListValues, setIniListValues };
