/**
 * Escape a filesystem path for use as an unquoted filter option value.
 *
 * FFmpeg unescapes twice: once when parsing the filtergraph and again when
 * parsing a filter's options. A character that is special to the option parser
 * therefore needs two levels of escaping, while one that is only special to the
 * graph parser needs one. The mapping below was verified against this FFmpeg
 * build for backslash, colon, equals, comma, semicolon, brackets, single quote
 * and space; `escapeFilterValue` output is never inlined with caption text.
 */
export function escapeFilterValue(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (char === '\\')
      escaped += '\\\\\\\\'; // literal backslash (special at both levels)
    else if (char === ':')
      escaped += '\\\\:'; // option separator
    else if (char === '=')
      escaped += '\\\\='; // option assignment
    else if (char === "'")
      escaped += "\\\\\\'"; // graph-level quote
    else if (char === ',')
      escaped += '\\,'; // filter separator
    else if (char === ';')
      escaped += '\\;'; // filterchain separator
    else if (char === '[') escaped += '\\[';
    else if (char === ']') escaped += '\\]';
    else escaped += char;
  }
  return escaped;
}
