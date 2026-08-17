import { describe, it, expect, afterEach } from 'vitest';
import { mountBoard, teardown, Mounted, dispatch, FetchStub, installDefaultRoutes, defaultBoardPayload, flushPromises } from './helpers';

// MarkdownEditor and its consumer (app.js's #task-desc-input) are pure DOM
// modules with no network dependency, so these tests only need
// markdown-editor.js (plus app.js for the MD-7 "opens prefilled" case).
describe('MD: markdown highlighting', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  function freshTextarea(mounted: Mounted): HTMLTextAreaElement {
    const doc = mounted.document;
    const ta = doc.createElement('textarea');
    ta.id = 'md-test-ta';
    doc.body.appendChild(ta);
    return ta as HTMLTextAreaElement;
  }

  it('MD-1: attach() wraps the textarea in .mde-wrap with a .mde-highlight layer behind it; the real textarea stays a textarea', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);

    const wrap = ta.parentElement!;
    expect(wrap.classList.contains('mde-wrap')).toBe(true);
    const highlight = wrap.querySelector('.mde-highlight');
    expect(highlight).toBeTruthy();
    expect(highlight!.tagName).toBe('PRE');
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.contentEditable).not.toBe('true');
  });

  it('MD-1b: attach() is idempotent — calling twice adds exactly one wrapper', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    w.MarkdownEditor.attach(ta);
    const wraps = mounted.document.querySelectorAll('.mde-wrap');
    expect(wraps.length).toBe(1);
    expect(wraps[0].querySelectorAll('.mde-highlight').length).toBe(1);
  });

  it('MD-1c: .value stays the raw unmodified markdown after attach/typing', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = '# Title\n\n**bold** and _italic_';
    dispatch(ta, 'input');
    expect(ta.value).toBe('# Title\n\n**bold** and _italic_');
  });

  it('MD-2: headers render with distinct classes per level plus the marker', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = '# Heading one\n## Heading two\nbody text';
    dispatch(ta, 'input');

    const highlight = ta.parentElement!.querySelector('.mde-highlight')!;
    expect(highlight.querySelector('.mde-h1')!.textContent).toBe('Heading one');
    expect(highlight.querySelector('.mde-h2')!.textContent).toBe('Heading two');
    expect(highlight.querySelectorAll('.mde-header-mark').length).toBe(2);
    expect(highlight.innerHTML).toContain('body text');
  });

  it('MD-3: list markers get .mde-list-marker for -, *, and ordered lists', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = '- alpha\n* beta\n1. gamma';
    dispatch(ta, 'input');

    const markers = ta.parentElement!.querySelector('.mde-highlight')!.querySelectorAll('.mde-list-marker');
    expect(markers.length).toBe(3);
    expect(Array.from(markers).map((m) => m.textContent)).toEqual(['-', '*', '1.']);
  });

  it('MD-4: inline code, fence, bold, italic, blockquote, link, and hr each get their class', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = [
      '`inline code`',
      '```',
      'fenced block',
      '```',
      '**bold**',
      '_italic_',
      '> quote',
      '[text](https://example.com)',
      '---'
    ].join('\n');
    dispatch(ta, 'input');

    const h = ta.parentElement!.querySelector('.mde-highlight')!;
    expect(h.querySelector('.mde-code-inline')!.textContent).toBe('`inline code`');
    expect(h.querySelectorAll('.mde-fence').length).toBe(2);
    expect(h.querySelector('.mde-code-line')!.textContent).toBe('fenced block');
    expect(h.querySelector('.mde-bold')!.textContent).toBe('**bold**');
    expect(h.querySelector('.mde-italic')!.textContent).toBe('_italic_');
    expect(h.querySelector('.mde-blockquote')!.textContent).toBe('quote');
    const linkText = h.querySelector('.mde-link-text')!;
    const linkUrl = h.querySelector('.mde-link-url')!;
    expect(linkText.textContent).toBe('[text]');
    expect(linkUrl.textContent).toBe('(https://example.com)');
    expect(linkText.textContent).not.toBe(linkUrl.textContent);
    expect(h.querySelector('.mde-hr')).toBeTruthy();
  });

  it('MD-5 (structural): a header line does not shift the highlight text of the following body line', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = '# A long heading that would visually wrap in a narrow textarea\nbody text right after';
    dispatch(ta, 'input');

    const h = ta.parentElement!.querySelector('.mde-highlight')!;
    // Real caret/pixel alignment isn't assertable in jsdom (no layout engine) —
    // this only checks the thing that WOULD break alignment: one source line
    // in must stay one rendered line out, so a header's bigger font-size
    // can't offset later lines. See report for the explicit "untestable" note.
    const lines = h.innerHTML.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('body text right after');
  });

  it('MD-6 (structural): scrolling the textarea syncs the highlight layer scroll position', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    ta.value = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    dispatch(ta, 'input');

    const pre = ta.parentElement!.querySelector('.mde-highlight') as HTMLElement;
    Object.defineProperty(ta, 'scrollTop', { value: 123, writable: true, configurable: true });
    Object.defineProperty(ta, 'scrollLeft', { value: 45, writable: true, configurable: true });
    dispatch(ta, 'scroll');
    expect(pre.scrollTop).toBe(123);
    expect(pre.scrollLeft).toBe(45);
  });

  it('MD-7: refresh() re-highlights after a programmatic .value assignment (no input event)', async () => {
    const stub = new FetchStub();
    installDefaultRoutes(stub, defaultBoardPayload({ projects: [{ id: 'demo', name: 'demo project', path: '/tmp/x', adws: [] }] }));
    mounted = mountBoard({ fetchStub: stub });
    const w = mounted.window as any;
    w.setupEventListeners();
    await w.fetchBoardState();
    await flushPromises();

    w.openTaskModal({ id: 't1', name: 'existing task', project: 'demo', status: 'todo', description: '# Already Saved\nsome body' });

    const ta = mounted.document.getElementById('task-desc-input') as HTMLTextAreaElement;
    expect(ta.value).toBe('# Already Saved\nsome body');
    const h = ta.parentElement!.querySelector('.mde-highlight')!;
    expect(h.querySelector('.mde-h1')!.textContent).toBe('Already Saved');
  });

  it('MD-8: the raw value round-trips unmodified — no injected markup', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);
    const raw = '# Title\n\n- item **bold**\n\n> quoted [link](https://x.test)';
    ta.value = raw;
    dispatch(ta, 'input');
    expect(ta.value).toBe(raw);
    w.MarkdownEditor.refresh(ta);
    expect(ta.value).toBe(raw);
  });

  it('MD-9 (security): markdown source is not executed — no img/script elements ever land in the highlight layer', () => {
    mounted = mountBoard({ scripts: ['markdown-editor.js'] });
    const w = mounted.window as any;
    const ta = freshTextarea(mounted);
    w.MarkdownEditor.attach(ta);

    ta.value = '<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[x](javascript:alert(1))';
    dispatch(ta, 'input');

    const h = ta.parentElement!.querySelector('.mde-highlight')!;
    expect(h.querySelectorAll('img').length).toBe(0);
    expect(h.querySelectorAll('script').length).toBe(0);
    expect(h.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(h.textContent).toContain('<script>alert(1)</script>');
    expect(h.textContent).toContain('javascript:alert(1)');
  });
});
