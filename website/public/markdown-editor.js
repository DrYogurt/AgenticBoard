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

    var handle = { textarea: textareaEl, pre: pre, wrapper: wrapper };

    var onInput = function () {
      render(handle);
    };
    var onScroll = function () {
      syncScroll(handle);
    };

    textareaEl.addEventListener('input', onInput);
    textareaEl.addEventListener('scroll', onScroll);

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
