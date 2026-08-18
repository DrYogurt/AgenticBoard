// AgenticBoard — Python syntax highlighting for the workflow script editor.
//
// A pure tokenizer (source string -> escaped HTML with span-wrapped tokens),
// deliberately regex-based rather than a real parser — good enough for
// readability, not a linter. Unlike markdown-editor.js's header highlighting,
// nothing here changes font size/weight or uses transform: scale() — pure
// color only, on the same monospace font — so a plain overlay + transparent
// textarea keeps the native caret pixel-correct everywhere with no synthetic
// caret needed (color spans don't shift character metrics).
//
// Public API: window.PythonHighlight = { highlight(code) }

(function () {
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var KEYWORDS = [
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
    'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
    'while', 'with', 'yield', 'self', 'match', 'case'
  ];
  var KEYWORD_SET = {};
  KEYWORDS.forEach(function (k) { KEYWORD_SET[k] = true; });

  var STRING_PREFIX_RE = /^[A-Za-z]{0,3}(?=["'])/; // r, b, f, rb, etc.

  // Tokenizes one line, carrying "inside an unterminated triple-quoted
  // string" state across calls — mirrors markdown-editor.js's fence-state
  // approach for the same reason (a string/comment can span many lines).
  function highlightLine(line, state) {
    var out = '';
    var i = 0;
    var n = line.length;

    if (state.inTriple) {
      var closeIdx = line.indexOf(state.tripleQuote);
      if (closeIdx === -1) {
        return { html: '<span class="py-string">' + escapeHtml(line) + '</span>', state: state };
      }
      out += '<span class="py-string">' + escapeHtml(line.slice(0, closeIdx + 3)) + '</span>';
      i = closeIdx + 3;
      state = { inTriple: false, tripleQuote: null };
    }

    while (i < n) {
      var ch = line[i];
      var rest = line.slice(i);

      if (ch === '#') {
        out += '<span class="py-comment">' + escapeHtml(rest) + '</span>';
        break;
      }

      var tripleMatch = /^("""|''')/.exec(rest);
      if (tripleMatch) {
        var quote = tripleMatch[1];
        var afterOpen = rest.slice(3);
        var closeIdx2 = afterOpen.indexOf(quote);
        if (closeIdx2 === -1) {
          out += '<span class="py-string">' + escapeHtml(rest) + '</span>';
          state = { inTriple: true, tripleQuote: quote };
          break;
        }
        var full = quote + afterOpen.slice(0, closeIdx2) + quote;
        out += '<span class="py-string">' + escapeHtml(full) + '</span>';
        i += full.length;
        continue;
      }

      if (ch === '"' || ch === "'") {
        var strMatch = new RegExp('^' + ch + '(?:\\\\.|[^' + ch + '\\\\])*' + ch).exec(rest);
        if (strMatch) {
          out += '<span class="py-string">' + escapeHtml(strMatch[0]) + '</span>';
          i += strMatch[0].length;
        } else {
          out += '<span class="py-string">' + escapeHtml(rest) + '</span>';
          i = n;
        }
        continue;
      }

      if (ch === '@' && /^@[A-Za-z_]/.test(rest)) {
        var decMatch = /^@[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
        out += '<span class="py-decorator">' + escapeHtml(decMatch[0]) + '</span>';
        i += decMatch[0].length;
        continue;
      }

      var numMatch = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
      if (numMatch) {
        out += '<span class="py-number">' + escapeHtml(numMatch[0]) + '</span>';
        i += numMatch[0].length;
        continue;
      }

      var prefixMatch = STRING_PREFIX_RE.exec(rest);
      var identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (identMatch) {
        var word = identMatch[0];
        // A short letter prefix directly before a quote (f"...", rb'...')
        // is part of the string, not a separate identifier/keyword — let
        // the string branch handle it on the next loop iteration.
        if (prefixMatch && prefixMatch[0] === word) {
          out += escapeHtml(word);
        } else if (KEYWORD_SET[word]) {
          out += '<span class="py-keyword">' + escapeHtml(word) + '</span>';
        } else {
          out += escapeHtml(word);
        }
        i += word.length;
        continue;
      }

      out += escapeHtml(ch);
      i += 1;
    }

    return { html: out, state: state };
  }

  function highlight(code) {
    var lines = code.split('\n');
    var state = { inTriple: false, tripleQuote: null };
    var out = new Array(lines.length);
    for (var i = 0; i < lines.length; i++) {
      var result = highlightLine(lines[i], state);
      out[i] = result.html;
      state = result.state;
    }
    return out.join('\n');
  }

  window.PythonHighlight = { highlight: highlight };
})();
