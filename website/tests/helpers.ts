import fs from 'fs';
import path from 'path';
import { JSDOM, DOMWindow } from 'jsdom';

export const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function readPublicFile(name: string): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf-8');
}

export interface FetchCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  isFormData: boolean;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

type RouteHandler = (ctx: {
  url: URL;
  method: string;
  body: any;
  headers: Record<string, string>;
}) => { status?: number; json?: any } | Promise<{ status?: number; json?: any }>;

// Minimal routable fetch stub. Tests register handlers per path/method; every
// call is recorded so assertions can inspect exactly what app.js sent
// (headers, body shape, FormData-ness) without touching a real network.
export class FetchStub {
  calls: FetchCall[] = [];
  private routes: Array<{ method: string; test: (p: string) => boolean; handler: RouteHandler }> = [];

  on(method: string, matcher: string | RegExp, handler: RouteHandler): this {
    const test = typeof matcher === 'string' ? (p: string) => p === matcher : (p: string) => matcher.test(p);
    this.routes.push({ method: method.toUpperCase(), test, handler });
    return this;
  }

  fetch = async (input: string, init: any = {}): Promise<FakeResponse> => {
    const method = (init.method || 'GET').toUpperCase();
    const url = new URL(input, 'http://localhost/');
    const isFormData = !!(init.body && typeof init.body === 'object' && init.body.constructor && init.body.constructor.name === 'FormData');
    let parsedBody: any = undefined;
    if (init.body !== undefined && init.body !== null && !isFormData) {
      if (typeof init.body === 'string') {
        try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
      } else {
        parsedBody = init.body;
      }
    } else if (isFormData) {
      parsedBody = init.body;
    }

    this.calls.push({
      path: url.pathname + url.search,
      method,
      headers: init.headers || {},
      body: parsedBody,
      isFormData
    });

    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      if (r.method === method && r.test(url.pathname)) {
        const result = await r.handler({ url, method, body: parsedBody, headers: init.headers || {} });
        return makeResponse(result.status ?? 200, result.json !== undefined ? result.json : { success: true, data: [] });
      }
    }
    return makeResponse(404, { success: false, error: `no stub route for ${method} ${url.pathname}` });
  };
}

function makeResponse(status: number, jsonBody: any): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody)
  };
}

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const DEFAULT_SCRIPTS = ['trace.js', 'markdown-editor.js', 'workflow-diagram.js', 'project-view.js', 'app.js'];

export interface Mounted {
  dom: JSDOM;
  window: DOMWindow;
  document: Document;
  fetchStub: FetchStub;
}

// Installs the REAL index.html into a fresh jsdom document, stubs fetch/
// EventSource, then evaluates the real script files' source in that window.
// All scripts are concatenated and indirect-eval'd (window.eval) as ONE
// program — a separate window.eval() call per file would give each its own
// throwaway top-level lexical scope, so a later file's `const`/`let` (e.g.
// app.js's `state`) wouldn't be visible even to test code evaluated
// afterward in the "same" window. Concatenating keeps every file's
// top-level declarations in one shared scope, exactly like normal
// same-page <script> tags. Top-level `function` declarations
// (apiCall, renderProjectsList, formatFileSize, ...) land on `window`
// either way; only `const`/`let` (state, dom, AgenticTrace) need this.
export function mountBoard(opts: { fetchStub?: FetchStub; scripts?: string[] } = {}): Mounted {
  const html = readPublicFile('index.html');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously' });
  const window = dom.window;
  const fetchStub = opts.fetchStub || new FetchStub();
  (window as any).fetch = fetchStub.fetch;
  (window as any).EventSource = FakeEventSource;
  // jsdom doesn't implement layout, so scrollIntoView is simply absent —
  // several real flows (adding a workflow, jumping from a diagram node to
  // its list-view card) call it purely as a UX nicety with no return value
  // anything reads, so a no-op stub is sufficient here.
  (window as any).HTMLElement.prototype.scrollIntoView = function () {};

  // jsdom fires DOMContentLoaded on its own (queued after parsing, which
  // completes before our synchronous eval below runs), which would otherwise
  // auto-trigger app.js's boot (setupEventListeners/fetchBoardState/initSSE)
  // asynchronously and unpredictably, including after a test's teardown has
  // already closed the window. Swallowing the registration keeps boot fully
  // in the test's hands — call window.setupEventListeners()/fetchBoardState()
  // explicitly instead.
  const suppressAutoBoot = `
    (function () {
      var orig = document.addEventListener.bind(document);
      document.addEventListener = function (type, listener, options) {
        if (type === 'DOMContentLoaded') return;
        return orig(type, listener, options);
      };
    })();
  `;

  const scripts = opts.scripts || DEFAULT_SCRIPTS;
  let combined = suppressAutoBoot + '\n;\n' + scripts.map((s) => readPublicFile(s)).join('\n;\n');
  if (scripts.includes('app.js')) {
    // app.js never runs its own DOMContentLoaded boot in this harness (see
    // flushPromises doc below) — tests call window.setupEventListeners()/
    // fetchBoardState() explicitly instead. This exposes its module-scope
    // `state`/`dom` cache onto window for test assertions.
    combined += '\nwindow.__appState = state; window.__appDom = dom;\n';
  }
  window.eval(combined);

  return { dom, window, document: window.document, fetchStub };
}

export function teardown(mounted: Mounted) {
  mounted.window.close();
}

// jsdom fires DOMContentLoaded as a queued task shortly after construction,
// racing our synchronous script evaluation — sometimes before app.js's own
// listener is even registered. Rather than depend on that race, tests call
// the boot functions app.js exposes (setupEventListeners, fetchBoardState,
// initLiveClock) directly; that's deterministic and exercises the same code.
export async function flushPromises(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function defaultBoardPayload(overrides: Partial<{ board: any; tasks: any[]; projects: any[]; extensions: any[]; agents: any[] }> = {}) {
  return {
    board: overrides.board || {
      revision: 1,
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'in-progress', name: 'In Progress' },
        { id: 'done', name: 'Done' }
      ],
      task_order: { todo: [], 'in-progress': [], done: [] }
    },
    tasks: overrides.tasks || [],
    projects: overrides.projects || [],
    extensions: overrides.extensions || [],
    agents: overrides.agents || []
  };
}

// Wires the standard bootstrap endpoints (board/models/runs/live-agents) with
// sane empty-ish defaults so individual tests only need to override what they
// actually care about.
// Dispatches a real DOM event of `type` on `el` (works for Document or
// Element targets). Extra `init` fields that aren't Event constructor
// options (e.g. `key` for a synthetic keydown, or `dataTransfer` for a
// synthetic drop) are assigned directly onto the event afterward — Event
// instances are plain objects underneath, so this is enough for handlers
// that only read those properties.
// focus/blur don't bubble in the real DOM — app.js has a window-level
// 'focus' listener (auto-refetch-on-tab-focus) that a wrongly-bubbling
// synthetic focus event would spuriously trigger on every input focused
// in a test, so this must match real bubbling semantics, not just default
// to true.
const NON_BUBBLING_EVENTS = new Set(['focus', 'blur']);

function windowOf(el: any): DOMWindow {
  if (el.nodeType === 9) return el.defaultView; // Document
  if (el.window === el) return el; // Window itself
  return el.ownerDocument.defaultView; // Element
}

export function dispatch(el: any, type: string, init: Record<string, any> = {}) {
  const win = windowOf(el);
  const evt = new win.Event(type, { bubbles: !NON_BUBBLING_EVENTS.has(type), cancelable: true });
  Object.assign(evt, init);
  el.dispatchEvent(evt);
  return evt;
}

export function installDefaultRoutes(stub: FetchStub, payload = defaultBoardPayload()) {
  stub.on('GET', '/api/v1/board', () => ({ json: { success: true, data: payload } }));
  stub.on('GET', '/api/v1/models', () => ({ json: { success: true, data: [] } }));
  stub.on('GET', '/api/v1/runs/active', () => ({ json: { success: true, data: [] } }));
  stub.on('GET', '/api/v1/live-agents', () => ({ json: { success: true, data: [] } }));
  stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/documents$/, () => ({ json: { success: true, data: [] } }));
  stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/adw-agents$/, () => ({ json: { success: true, data: {} } }));
  return stub;
}
