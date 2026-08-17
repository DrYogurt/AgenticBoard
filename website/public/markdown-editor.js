(function () {
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var FENCE_OPEN_RE = /^(\s*)(`{3,})(.*)$/;
  var FENCE_CLOSE_RE = /^\s*`{3,}\s*$/;
  var HEADER_RE = /^(#{1,6})( +)(.*)$/;
  // Mirrors the transform: scale() factors in markdown-editor.css's .mde-hN
  // rules exactly — used to compute where the *visual* (scaled) caret
  // position falls, since the textarea's own native caret only ever tracks
  // the unscaled text and drifts further off the longer a header line gets.
  var HEADER_SCALE = { 1: 1.3, 2: 1.22, 3: 1.15, 4: 1.08, 5: 1.04, 6: 1 };
  var HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var BLOCKQUOTE_RE = /^(\s*)(&gt;)( ?)(.*)$/;
  var ORDERED_RE = /^(\s*)(\d+\.)(\s+)(.*)$/;
  var UNORDERED_RE = /^(\s*)([-*+])(\s+)(.*)$/;
  var INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]+?)\]\(([^)\n]+?)\)/g;

  function highlightInline(escapedText) {
    return escapedText.replace(
      INLINE_RE,
      function (match, code, bold, italicStar, italicUnderscore, linkText, linkUrl) {
        if (code !== undefined) return '<span class="mde-code-inline">`' + code + '`</span>';
        if (bold !== undefined) return '<span class="mde-bold">**' + bold + '**</span>';
        if (italicStar !== undefined) return '<span class="mde-italic">*' + italicStar + '*</span>';
        if (italicUnderscore !== undefined) return '<span class="mde-italic">_' + italicUnderscore + '_</span>';
        if (linkText !== undefined) {
          return (
            '<span class="mde-link-text">[' + linkText + ']</span>' +
            '<span class="mde-link-url">(' + linkUrl + ')</span>'
          );
        }
        return match;
      }
    );
  }

  function renderLine(rawLine, state) {
    var esc = escapeHtml(rawLine);

    if (state.inFence) {
      if (FENCE_CLOSE_RE.test(esc)) {
        state.inFence = false;
        return '<span class="mde-fence">' + esc + '</span>';
      }
      return '<span class="mde-code-line">' + esc + '</span>';
    }

    var m = FENCE_OPEN_RE.exec(esc);
    if (m) {
      state.inFence = true;
      return '<span class="mde-fence">' + esc + '</span>';
    }

    m = HEADER_RE.exec(esc);
    if (m) {
      var level = m[1].length;
      return (
        '<span class="mde-header-mark">' + m[1] + '</span>' +
        m[2] +
        '<span class="mde-h' + level + '">' + m[3] + '</span>'
      );
    }

    if (HR_RE.test(esc)) {
      return '<span class="mde-hr">' + esc + '</span>';
    }

    m = BLOCKQUOTE_RE.exec(esc);
    if (m) {
      return (
        '<span class="mde-blockquote-mark">' + m[1] + m[2] + m[3] + '</span>' +
        '<span class="mde-blockquote">' + highlightInline(m[4]) + '</span>'
      );
    }

    m = ORDERED_RE.exec(esc);
    if (m) {
      return (
        m[1] + '<span class="mde-list-marker">' + m[2] + '</span>' + m[3] + highlightInline(m[4])
      );
    }

    m = UNORDERED_RE.exec(esc);
    if (m) {
      return (
        m[1] + '<span class="mde-list-marker">' + m[2] + '</span>' + m[3] + highlightInline(m[4])
      );
    }

    return highlightInline(esc);
  }

  function highlightMarkdown(text) {
    var lines = text.split('\n');
    var state = { inFence: false };
    var out = new Array(lines.length);
    for (var i = 0; i < lines.length; i++) {
      out[i] = renderLine(lines[i], state);
    }
    return out.join('\n');
  }

  function syncScroll(handle) {
    handle.pre.scrollTop = handle.textarea.scrollTop;
    handle.pre.scrollLeft = handle.textarea.scrollLeft;
  }

  function render(handle) {
    handle.pre.innerHTML = highlightMarkdown(handle.textarea.value);
    syncScroll(handle);
    updateCaret(handle);
  }

  // Both layers use the same monospace font (see .mde-surface), so a
  // character's x position is just column * charWidth — no DOM Range
  // measurement needed, which is what makes the arithmetic in updateCaret
  // tractable at all.
  function measureCharWidth(referenceEl) {
    var probe = document.createElement('span');
    var cs = getComputedStyle(referenceEl);
    probe.style.font = cs.font || (cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontFamily);
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.textContent = '0123456789';
    document.body.appendChild(probe);
    var width = probe.getBoundingClientRect().width / 10;
    document.body.removeChild(probe);
    return width || 0;
  }

  // The textarea's own native caret is correct everywhere EXCEPT on a
  // header line: transform: scale() (see markdown-editor.css) makes the
  // *visible* glyphs in .mde-highlight wider than the *actual* (unscaled)
  // text the native caret tracks in the invisible textarea underneath, so
  // clicking anywhere past the first character of a scaled header lands
  // the real caret well behind where it visually appears. Since both
  // layers share one monospace font and there's no soft-wrap, the scaled
  // x position is plain arithmetic: unscaled up through the "## " mark,
  // then column * charWidth * levelScale beyond it. When the caret sits on
  // a header line, hide the native caret (caret-color: transparent) and
  // draw this synthetic one instead; everywhere else, the native caret is
  // already pixel-correct and this stays hidden.
  function updateCaret(handle) {
    var ta = handle.textarea;
    if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) {
      handle.caret.classList.add('hidden');
      ta.style.caretColor = '';
      return;
    }
    var value = ta.value;
    var pos = ta.selectionStart;
    var lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    var lineEndIdx = value.indexOf('\n', pos);
    var lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    var lineIndex = value.slice(0, lineStart).split('\n').length - 1;
    var col = pos - lineStart;
    var lineText = value.slice(lineStart, lineEnd);
    var m = HEADER_RE.exec(lineText);
    if (!m) {
      handle.caret.classList.add('hidden');
      ta.style.caretColor = '';
      return;
    }
    var prefixLen = m[1].length + m[2].length; // e.g. "## " -> 3
    var scale = HEADER_SCALE[m[1].length] || 1;
    var x = col <= prefixLen
      ? col * handle.charWidth
      : prefixLen * handle.charWidth + (col - prefixLen) * handle.charWidth * scale;
    var y = lineIndex * handle.lineHeight;
    handle.caret.style.left = (handle.padLeft + x - ta.scrollLeft) + 'px';
    handle.caret.style.top = (handle.padTop + y - ta.scrollTop) + 'px';
    handle.caret.style.height = handle.lineHeight + 'px';
    handle.caret.classList.remove('hidden');
    ta.style.caretColor = 'transparent';
  }

  function attach(textareaEl) {
    if (!textareaEl) return null;
    if (textareaEl.__mdEditorHandle) return textareaEl.__mdEditorHandle;

    var wrapper = document.createElement('div');
    wrapper.className = 'mde-wrap';

    var pre = document.createElement('pre');
    pre.className = 'mde-surface mde-highlight';
    pre.setAttribute('aria-hidden', 'true');

    var parent = textareaEl.parentNode;
    parent.insertBefore(wrapper, textareaEl);
    wrapper.appendChild(pre);
    wrapper.appendChild(textareaEl);

    textareaEl.classList.add('mde-surface', 'mde-textarea');
    // no soft-wrap: keeps the pre's and textarea's visual line count identical per
    // source line, so a header's larger font-size can never wrap differently and
    // throw off vertical alignment on later lines
    textareaEl.setAttribute('wrap', 'off');
    textareaEl.spellcheck = false;

    var caret = document.createElement('div');
    caret.className = 'mde-synthetic-caret hidden';
    wrapper.appendChild(caret);

    var cs = getComputedStyle(textareaEl);
    var handle = {
      textarea: textareaEl,
      pre: pre,
      wrapper: wrapper,
      caret: caret,
      charWidth: measureCharWidth(textareaEl),
      lineHeight: parseFloat(cs.lineHeight) || 19,
      padLeft: parseFloat(cs.paddingLeft) || 0,
      padTop: parseFloat(cs.paddingTop) || 0
    };

    var onInput = function () {
      render(handle);
    };
    var onScroll = function () {
      syncScroll(handle);
      updateCaret(handle);
    };
    var onCaretMove = function () {
      updateCaret(handle);
    };
    var onBlur = function () {
      updateCaret(handle);
    };

    textareaEl.addEventListener('input', onInput);
    textareaEl.addEventListener('scroll', onScroll);
    textareaEl.addEventListener('click', onCaretMove);
    textareaEl.addEventListener('keyup', onCaretMove);
    textareaEl.addEventListener('focus', onCaretMove);
    textareaEl.addEventListener('blur', onBlur);

    textareaEl.__mdEditorHandle = handle;
    render(handle);
    return handle;
  }

  function refresh(textareaEl) {
    if (!textareaEl) return;
    var handle = textareaEl.__mdEditorHandle || attach(textareaEl);
    render(handle);
  }

  window.MarkdownEditor = { attach: attach, refresh: refresh };
})();
