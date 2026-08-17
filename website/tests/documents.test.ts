import { describe, it, expect, afterEach } from 'vitest';
import { mountBoard, teardown, installDefaultRoutes, defaultBoardPayload, FetchStub, flushPromises, Mounted, dispatch } from './helpers';

function demoProject(overrides: any = {}) {
  return { id: 'demo', name: 'demo project', path: '/tmp/ab-verify-proj', adws: [], ...overrides };
}

function setupBoard(projects: any[]) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, defaultBoardPayload({ projects }));
  const mounted = mountBoard({ fetchStub: stub });
  return { mounted, stub };
}

async function boot(mounted: Mounted) {
  const w = mounted.window as any;
  w.setupEventListeners();
  await w.fetchBoardState();
  await flushPromises();
}

describe('DU: document upload', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('DU-1: #task-documents-group sits below #task-desc-input, labelled, containing the box and file input', () => {
    mounted = mountBoard();
    const doc = mounted.document;
    const desc = doc.getElementById('task-desc-input')!;
    const group = doc.getElementById('task-documents-group')!;
    expect(group).toBeTruthy();
    const win = mounted.window as any;
    expect(desc.compareDocumentPosition(group) & win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.querySelector('label')!.textContent).toMatch(/upload documents/i);
    expect(group.querySelector('#doc-upload-box')).toBeTruthy();
    expect(group.querySelector('#doc-upload-input')).toBeTruthy();
  });

  it('DU-2: #doc-upload-target names the destination and follows the selected project', async () => {
    const setup = setupBoard([demoProject({ id: 'demo' }), demoProject({ id: 'other', name: 'other project' })]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;

    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';
    await w.refreshDocList();
    expect(doc.getElementById('doc-upload-target')!.textContent).toBe('→ demo/documents');

    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'other';
    dispatch(doc.getElementById('task-project-input')!, 'change');
    await flushPromises();
    expect(doc.getElementById('doc-upload-target')!.textContent).toBe('→ other/documents');
  });

  it('DU-3: uploading a file reports success and lists it with a human-readable size', async () => {
    const setup = setupBoard([demoProject()]);
    let stored: any[] = [];
    setup.stub.on('POST', /^\/api\/v1\/projects\/demo\/documents$/, ({ body }) => {
      expect(body && body.constructor && body.constructor.name).toBe('FormData');
      stored = [{ filename: 'hello.md', size: 8 }];
      return { json: { success: true, data: stored } };
    });
    setup.stub.on('GET', '/api/v1/projects/demo/documents', () => ({ json: { success: true, data: stored } }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';

    const file = new (mounted.window as any).File(['# hello'], 'hello.md', { type: 'text/markdown' });
    await w.uploadDocuments([file]);
    await flushPromises();

    const status = doc.getElementById('doc-upload-status')!;
    expect(status.textContent).toContain('uploaded 1 file(s)');
    expect(status.className).toContain('success');

    const list = doc.getElementById('doc-list')!;
    expect(list.textContent).toContain('hello.md');
    expect(list.textContent).toContain('8 B');
  });

  it('DU-4: multiple files upload in one go and are all listed', async () => {
    const setup = setupBoard([demoProject()]);
    let stored: any[] = [];
    setup.stub.on('POST', '/api/v1/projects/demo/documents', ({ body }) => {
      const names: string[] = [];
      for (const [k, v] of (body as any).entries()) {
        if (k === 'files') names.push((v as any).name);
      }
      expect(names).toEqual(['a.md', 'b.md']);
      stored = names.map((n) => ({ filename: n, size: 10 }));
      return { json: { success: true, data: stored } };
    });
    setup.stub.on('GET', '/api/v1/projects/demo/documents', () => ({ json: { success: true, data: stored } }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';

    const fileA = new (mounted.window as any).File(['aaaa'], 'a.md');
    const fileB = new (mounted.window as any).File(['bbbb'], 'b.md');
    await w.uploadDocuments([fileA, fileB]);
    await flushPromises();

    const list = doc.getElementById('doc-list')!;
    expect(list.textContent).toContain('a.md');
    expect(list.textContent).toContain('b.md');
    expect(list.querySelectorAll('.doc-list-item').length).toBe(2);
  });

  it('DU field name and content-type: uploads as real multipart FormData under field "files", no JSON content-type', async () => {
    const setup = setupBoard([demoProject()]);
    setup.stub.on('POST', '/api/v1/projects/demo/documents', () => ({ json: { success: true, data: [] } }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';

    const file = new (mounted.window as any).File(['x'], 'x.md');
    await w.uploadDocuments([file]);
    await flushPromises();

    const call = setup.stub.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/projects/demo/documents');
    expect(call).toBeTruthy();
    expect(call!.isFormData).toBe(true);
    expect(call!.body.constructor.name).toBe('FormData');
    const fieldNames = Array.from((call!.body as any).keys());
    expect(fieldNames).toEqual(['files']);
    const headers = call!.headers || {};
    const contentTypeHeader = Object.keys(headers).find((h) => h.toLowerCase() === 'content-type');
    expect(contentTypeHeader === undefined || !String((headers as any)[contentTypeHeader]).includes('application/json')).toBe(true);
  });

  it('DU-5: dragover state toggles .dragover on dragenter/dragleave', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const box = mounted.document.getElementById('doc-upload-box')!;
    expect(box.classList.contains('dragover')).toBe(false);
    dispatch(box, 'dragenter');
    expect(box.classList.contains('dragover')).toBe(true);
    dispatch(box, 'dragleave');
    expect(box.classList.contains('dragover')).toBe(false);
  });

  it('DU-5b: dropping a file (synthetic dataTransfer) uploads it', async () => {
    const setup = setupBoard([demoProject()]);
    let stored: any[] = [];
    setup.stub.on('POST', '/api/v1/projects/demo/documents', () => {
      stored = [{ filename: 'dropped.md', size: 3 }];
      return { json: { success: true, data: stored } };
    });
    setup.stub.on('GET', '/api/v1/projects/demo/documents', () => ({ json: { success: true, data: stored } }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';

    const box = doc.getElementById('doc-upload-box')!;
    const file = new (mounted.window as any).File(['abc'], 'dropped.md');
    dispatch(box, 'drop', { dataTransfer: { files: [file] } });
    await flushPromises();

    expect(box.classList.contains('dragover')).toBe(false);
    expect(doc.getElementById('doc-list')!.textContent).toContain('dropped.md');
  });

  it('DU-6: reopening the task modal lists existing documents fetched via GET', async () => {
    const setup = setupBoard([demoProject()]);
    setup.stub.on('GET', '/api/v1/projects/demo/documents', () => ({
      json: { success: true, data: [{ filename: 'existing.md', size: 2048 }] }
    }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal({ id: 't1', name: 'task one', project: 'demo', status: 'todo' });
    await flushPromises();

    const list = doc.getElementById('doc-list')!;
    expect(list.textContent).toContain('existing.md');
    expect(list.textContent).toContain('2.0 KB');

    const getCall = setup.stub.calls.find((c) => c.method === 'GET' && c.path === '/api/v1/projects/demo/documents');
    expect(getCall).toBeTruthy();
  });

  it('DU-7: uploading with no project selected shows "select a project first" as an error', async () => {
    const setup = setupBoard([]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    expect((doc.getElementById('task-project-input') as HTMLSelectElement).value).toBe('');

    const file = new (mounted.window as any).File(['x'], 'x.md');
    await w.uploadDocuments([file]);

    const status = doc.getElementById('doc-upload-status')!;
    expect(status.textContent).toBe('select a project first');
    expect(status.className).toContain('error');
  });

  it('refreshDocList tolerates a failing GET without throwing', async () => {
    const setup = setupBoard([demoProject()]);
    setup.stub.on('GET', '/api/v1/projects/demo/documents', () => ({ status: 500, json: { success: false, error: 'boom' } }));
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    const doc = mounted.document;
    w.openTaskModal();
    (doc.getElementById('task-project-input') as HTMLSelectElement).value = 'demo';
    await expect(w.refreshDocList()).resolves.not.toThrow();
    expect(doc.getElementById('doc-list')!.children.length).toBe(0);
  });

  it('formatFileSize boundaries (bytes / KB / MB)', () => {
    mounted = mountBoard();
    const w = mounted.window as any;
    expect(w.formatFileSize(0)).toBe('0 B');
    expect(w.formatFileSize(1023)).toBe('1023 B');
    expect(w.formatFileSize(1024)).toBe('1.0 KB');
    expect(w.formatFileSize(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(w.formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(w.formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
