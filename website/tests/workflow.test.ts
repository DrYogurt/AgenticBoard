import { describe, it, expect, afterEach } from 'vitest';
import { mountBoard, teardown, installDefaultRoutes, defaultBoardPayload, FetchStub, flushPromises, Mounted, dispatch } from './helpers';

function demoProject(overrides: any = {}) {
  return {
    id: 'demo',
    name: 'demo project',
    path: '/tmp/ab-verify-proj',
    agent_files: ['CLAUDE.md'],
    adws: [
      {
        id: 'build-feature',
        name: 'Build Feature',
        path: 'adws/build_feature.py',
        model: 'anthropic/claude-3-opus',
        parameters: [{ name: 'agent', flag: '--agent', type: 'agent', default: 'coder' }]
      }
    ],
    ...overrides
  };
}

function makeModels(n = 3, provider = 'anthropic') {
  return Array.from({ length: n }, (_, i) => ({
    provider,
    model: `model-${i}`,
    id: `${provider}/model-${i}`
  }));
}

function setupBoard(projects: any[], modelsResponder?: () => { status?: number; json?: any }) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, defaultBoardPayload({ projects }));
  if (modelsResponder) {
    stub.on('GET', '/api/v1/models', modelsResponder);
  }
  const mounted = mountBoard({ fetchStub: stub });
  return { mounted, stub };
}

async function boot(mounted: Mounted) {
  const w = mounted.window as any;
  w.setupEventListeners();
  await w.fetchBoardState();
  await flushPromises();
}

describe('WF: workflow editor', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('WF-1: project search bar exists above the project list with name/prefix/path placeholder', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    w.openProjectsModal();
    const doc = mounted.document;
    const input = doc.getElementById('project-search-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(doc.getElementById('modal-projects')!.contains(input)).toBe(true);
    expect(input.placeholder.toLowerCase()).toContain('name');
    expect(input.placeholder.toLowerCase()).toContain('prefix');
    expect(input.placeholder.toLowerCase()).toContain('path');
    const container = doc.getElementById('projects-container')!;
    const win = mounted.window as any;
    expect(input.compareDocumentPosition(container) & win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('WF-2: search filters by name, id/prefix, and path, case-insensitively; no-match message; clearing restores', async () => {
    const projects = [
      demoProject({ id: 'demo', name: 'demo project', path: '/tmp/ab-verify-proj' }),
      demoProject({ id: 'other', name: 'other thing', path: '/srv/apps/widget', adws: [] })
    ];
    const setup = setupBoard(projects);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    w.openProjectsModal();
    const doc = mounted.document;
    const input = doc.getElementById('project-search-input') as HTMLInputElement;
    const container = doc.getElementById('projects-container')!;

    expect(container.querySelectorAll('.project-row').length).toBe(2);

    input.value = 'DEMO';
    dispatch(input, 'input');
    let rows = container.querySelectorAll('.project-row');
    expect(rows.length).toBe(1);
    expect((rows[0] as HTMLElement).dataset.projectId).toBe('demo');

    input.value = 'other';
    dispatch(input, 'input');
    rows = container.querySelectorAll('.project-row');
    expect(rows.length).toBe(1);
    expect((rows[0] as HTMLElement).dataset.projectId).toBe('other');

    input.value = '/srv/apps';
    dispatch(input, 'input');
    rows = container.querySelectorAll('.project-row');
    expect(rows.length).toBe(1);
    expect((rows[0] as HTMLElement).dataset.projectId).toBe('other');

    input.value = 'zzzz';
    dispatch(input, 'input');
    expect(container.querySelectorAll('.project-row').length).toBe(0);
    expect(container.textContent).toContain('No projects match "zzzz".');

    input.value = '';
    dispatch(input, 'input');
    expect(container.querySelectorAll('.project-row').length).toBe(2);
  });

  it('WF-3: project rows carry .project-row and data-project-id', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    w.openProjectsModal();
    const row = mounted.document.querySelector('.project-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.dataset.projectId).toBe('demo');
    expect(row.classList.contains('item-card-row')).toBe(true);
  });

  it('WF-4: clicking a project row opens the project view populated with title/meta/adw list', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    w.openProjectsModal();
    const row = mounted.document.querySelector('.project-row[data-project-id="demo"]') as HTMLElement;
    dispatch(row, 'click');
    await flushPromises();

    const doc = mounted.document;
    const modal = doc.getElementById('modal-project-view')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('pv-modal-title')!.textContent).toContain('demo project');
    const meta = doc.getElementById('pv-meta')!.textContent || '';
    expect(meta).toContain('demo');
    expect(meta).toContain('/tmp/ab-verify-proj');
    const adwList = doc.getElementById('pv-adw-list')!;
    expect(adwList.textContent).toContain('build-feature');
  });

  it('WF-4b: empty-adws project shows an empty state in pv-adw-list', async () => {
    const setup = setupBoard([demoProject({ id: 'bare', name: 'bare project', adws: [] })]);
    mounted = setup.mounted;
    await boot(mounted);
    const w = mounted.window as any;
    await w.ProjectView.open('bare');
    await flushPromises();
    const adwList = mounted.document.getElementById('pv-adw-list')!;
    expect(adwList.textContent).toContain('no workflows registered');
  });

  async function openProjectView(mounted: Mounted, projectId = 'demo') {
    const w = mounted.window as any;
    await w.ProjectView.open(projectId);
    await flushPromises();
    return mounted.document;
  }

  it('WF-5: ADW fields are editable for id, name, path, model, parameters (agent selection lives in parameters)', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    card.classList.add('pv-expanded');

    const idInput = card.querySelector('input[placeholder="e.g. build-feature"]') as HTMLInputElement;
    const nameInput = card.querySelector('input[placeholder="e.g. Build Feature"]') as HTMLInputElement;
    const pathInput = card.querySelector('input[placeholder="e.g. adws/build_feature.py"]') as HTMLInputElement;
    const modelInput = card.querySelector('input[placeholder="search or type a model..."]') as HTMLInputElement;
    expect(idInput).toBeTruthy();
    expect(nameInput).toBeTruthy();
    expect(pathInput).toBeTruthy();
    expect(modelInput).toBeTruthy();
    expect(card.querySelector('.pv-params-list')).toBeTruthy();
    // No separate ADW-level "agents" list — the fixture's agent-typed
    // parameter is what shows an agent id here.
    expect(card.querySelector('.pv-agents-list')).toBeFalsy();

    idInput.value = 'build-feature-v2';
    expect(() => dispatch(idInput, 'input')).not.toThrow();
    expect(idInput.value).toBe('build-feature-v2');

    nameInput.value = 'Build Feature V2';
    expect(() => dispatch(nameInput, 'input')).not.toThrow();

    pathInput.value = 'adws/v2.py';
    expect(() => dispatch(pathInput, 'input')).not.toThrow();
  });

  it('WF-6: an agent-typed parameter swaps its default field for an agent-id picker', async () => {
    const setup = setupBoard([demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })]);
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    const addParamBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === '+ parameter') as HTMLButtonElement;
    dispatch(addParamBtn, 'click');

    let row = card.querySelector('.pv-param-row') as HTMLElement;
    const typeSelect = row.querySelector('select') as HTMLSelectElement;
    // Before switching type, the default field is a plain text input.
    expect(row.querySelector('.pv-agent-name-picker')).toBeFalsy();

    typeSelect.value = 'agent';
    dispatch(typeSelect, 'change');

    row = card.querySelector('.pv-param-row') as HTMLElement;
    const agentPickerInput = row.querySelector('.pv-agent-name-picker input') as HTMLInputElement;
    expect(agentPickerInput).toBeTruthy();

    agentPickerInput.value = 'builder';
    dispatch(agentPickerInput, 'input');
    expect(agentPickerInput.value).toBe('builder');

    // Switching back away from 'agent' reverts the default field to plain text.
    const typeSelect2 = row.querySelector('select') as HTMLSelectElement;
    typeSelect2.value = 'string';
    dispatch(typeSelect2, 'change');
    row = card.querySelector('.pv-param-row') as HTMLElement;
    expect(row.querySelector('.pv-agent-name-picker')).toBeFalsy();

    const rmBtn = row.querySelector('.pv-icon-btn') as HTMLButtonElement;
    dispatch(rmBtn, 'click');
    expect(card.querySelectorAll('.pv-param-row').length).toBe(0);
  });

  it('WF-7: add and remove a parameter; type constrained to string/number/boolean/agent', async () => {
    const setup = setupBoard([demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })]);
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    const addParamBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === '+ parameter') as HTMLButtonElement;
    dispatch(addParamBtn, 'click');

    const row = card.querySelector('.pv-param-row') as HTMLElement;
    const [nameInput, flagInput] = row.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
    const typeSelect = row.querySelector('select') as HTMLSelectElement;
    const options = Array.from(typeSelect.options).map((o) => o.value);
    expect(options).toEqual(['string', 'number', 'boolean', 'agent']);

    nameInput.value = 'branch';
    dispatch(nameInput, 'input');
    flagInput.value = '--branch';
    dispatch(flagInput, 'input');

    expect(nameInput.value).toBe('branch');
    expect(flagInput.value).toBe('--branch');

    const rmBtn = row.querySelector('.pv-icon-btn') as HTMLButtonElement;
    dispatch(rmBtn, 'click');
    expect(card.querySelectorAll('.pv-param-row').length).toBe(0);
  });

  it('WF-8: model picker lists provider and model name, both visible, fed by GET /api/v1/models', async () => {
    const models = [
      { provider: 'anthropic', model: 'claude-3-opus', id: 'anthropic/claude-3-opus' },
      { provider: 'google', model: 'gemini-pro', id: 'google/gemini-pro' }
    ];
    const setup = setupBoard(
      [demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })],
      () => ({ json: { success: true, data: models } })
    );
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const modelInput = doc.querySelector('.pv-model-picker input') as HTMLInputElement;
    dispatch(modelInput, 'focus');
    await flushPromises();

    const options = doc.querySelectorAll('.pv-model-option');
    expect(options.length).toBe(2);
    options.forEach((opt) => {
      expect(opt.querySelector('.pv-model-provider-badge')!.textContent).not.toBe('');
      expect(opt.querySelector('.pv-model-name')!.textContent).not.toBe('');
    });
    const texts = Array.from(options).map((o) => o.textContent);
    expect(texts.some((t) => t!.includes('anthropic') && t!.includes('claude-3-opus'))).toBe(true);
    expect(texts.some((t) => t!.includes('google') && t!.includes('gemini-pro'))).toBe(true);
  });

  it('WF-9: model picker search filters on both provider and model, capped with a hint', async () => {
    const models = [...makeModels(60, 'anthropic'), { provider: 'google', model: 'gemini-pro', id: 'google/gemini-pro' }];
    const setup = setupBoard(
      [demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })],
      () => ({ json: { success: true, data: models } })
    );
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const modelInput = doc.querySelector('.pv-model-picker input') as HTMLInputElement;
    dispatch(modelInput, 'focus');
    await flushPromises();

    // cap: 61 models but the dropdown should not render all of them
    expect(doc.querySelectorAll('.pv-model-option').length).toBeLessThanOrEqual(50);
    expect(doc.querySelector('.pv-model-dropdown-hint')!.textContent).toMatch(/more, keep typing/);

    modelInput.value = 'google';
    dispatch(modelInput, 'input');
    let options = doc.querySelectorAll('.pv-model-option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain('google');

    modelInput.value = 'model-5';
    dispatch(modelInput, 'input');
    options = doc.querySelectorAll('.pv-model-option');
    expect(options.length).toBeGreaterThan(0);
    Array.from(options).forEach((o) => expect(o.textContent).toContain('model-5'));
  });

  it('WF-10: selecting a model sets provider/model, and it can be cleared', async () => {
    const models = [{ provider: 'anthropic', model: 'claude-3-opus', id: 'anthropic/claude-3-opus' }];
    const setup = setupBoard(
      [demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })],
      () => ({ json: { success: true, data: models } })
    );
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const modelInput = doc.querySelector('.pv-model-picker input') as HTMLInputElement;
    dispatch(modelInput, 'focus');
    await flushPromises();

    const opt = doc.querySelector('.pv-model-option') as HTMLElement;
    dispatch(opt, 'mousedown');
    expect(modelInput.value).toBe('anthropic/claude-3-opus');

    const clearBtn = doc.querySelector('.pv-model-clear-btn') as HTMLButtonElement;
    dispatch(clearBtn, 'click');
    expect(modelInput.value).toBe('');
  });

  it('WF-11: model list degrades gracefully on failure — 200 + empty array, note shown, no throw', async () => {
    const setup = setupBoard([demoProject()], () => ({ json: { success: true, data: [], error: 'pi not installed' } }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const modelInput = doc.querySelector('.pv-model-picker input') as HTMLInputElement;

    expect(() => dispatch(modelInput, 'focus')).not.toThrow();
    await flushPromises();

    expect(doc.querySelector('.pv-model-dropdown-note')!.textContent).toContain('model list unavailable');

    modelInput.value = 'anthropic/hand-typed-model';
    dispatch(modelInput, 'input');
    expect(modelInput.value).toBe('anthropic/hand-typed-model');
  });

  it('WF-12: saving posts update_project with the complete adws array', async () => {
    const setup = setupBoard([demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })]);
    mounted = setup.mounted;
    setup.stub.on('POST', '/api/v1/command', ({ body }) => {
      expect(body.type).toBe('update_project');
      expect(body.payload.id).toBe('demo');
      return { json: { success: true, data: {} } };
    });
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    const addParamBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === '+ parameter') as HTMLButtonElement;
    dispatch(addParamBtn, 'click');
    let paramRow = card.querySelector('.pv-param-row') as HTMLElement;
    const [nameInput, flagInput] = paramRow.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
    nameInput.value = 'branch';
    dispatch(nameInput, 'input');
    flagInput.value = '--branch';
    dispatch(flagInput, 'input');

    // A second, agent-typed parameter to confirm its picker-based default
    // round-trips through save the same way a plain string default does.
    dispatch(addParamBtn, 'click');
    const rows = card.querySelectorAll('.pv-param-row');
    const agentRow = rows[rows.length - 1] as HTMLElement;
    const [agentNameInput, agentFlagInput] = agentRow.querySelectorAll('input') as NodeListOf<HTMLInputElement>;
    agentNameInput.value = 'agent';
    dispatch(agentNameInput, 'input');
    agentFlagInput.value = '--agent';
    dispatch(agentFlagInput, 'input');
    const agentTypeSelect = agentRow.querySelector('select') as HTMLSelectElement;
    agentTypeSelect.value = 'agent';
    dispatch(agentTypeSelect, 'change');
    const agentPickerInput = (card.querySelectorAll('.pv-param-row')[rows.length - 1] as HTMLElement)
      .querySelector('.pv-agent-name-picker input') as HTMLInputElement;
    agentPickerInput.value = 'coder';
    dispatch(agentPickerInput, 'input');

    const saveBtn = doc.getElementById('pv-save-btn') as HTMLButtonElement;
    dispatch(saveBtn, 'click');
    await flushPromises();

    const saveCall = setup.stub.calls.find((c) => c.path === '/api/v1/command' && c.method === 'POST');
    expect(saveCall).toBeTruthy();
    const adws = saveCall!.body.payload.adws;
    expect(adws).toHaveLength(1);
    expect(adws[0].id).toBe('wf');
    expect(adws[0].agents).toBeUndefined();
    expect(adws[0].parameters).toEqual([
      { name: 'branch', flag: '--branch', type: 'string' },
      { name: 'agent', flag: '--agent', type: 'agent', default: 'coder' }
    ]);

    const banner = doc.getElementById('pv-save-banner')!;
    expect(banner.textContent).toContain('saved.');
  });

  it('WF-13: a save conflict surfaces a readable error, not a silent failure or raw stack', async () => {
    const setup = setupBoard([demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })]);
    setup.stub.on('POST', '/api/v1/command', () => ({ status: 409, json: { success: false, error: 'revision conflict: board changed since load' } }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const saveBtn = doc.getElementById('pv-save-btn') as HTMLButtonElement;
    dispatch(saveBtn, 'click');
    await flushPromises();

    const banner = doc.getElementById('pv-save-banner')!;
    expect(banner.textContent).toContain('revision conflict');
    expect(banner.textContent).not.toContain('at ');
    expect(banner.querySelector('.pv-err')).toBeTruthy();
  });

  it('WF-14: renaming an ADW id shows an explicit orphan warning', async () => {
    const setup = setupBoard([demoProject({ adws: [{ id: 'wf', path: 'adws/wf.py', name: 'WF', parameters: [] }] })]);
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    const idInput = card.querySelector('input[placeholder="e.g. build-feature"]') as HTMLInputElement;
    const warning = card.querySelector('.pv-warning') as HTMLElement;
    expect(warning.style.display).toBe('none');

    idInput.value = 'wf-renamed';
    dispatch(idInput, 'input');
    expect(warning.style.display).not.toBe('none');
    expect(warning.textContent).toContain('orphan');
  });

  it('WF-15: project view closes via the close button and via Escape', async () => {
    const setup = setupBoard([demoProject()]);
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    const modal = doc.getElementById('modal-project-view')!;
    expect(modal.classList.contains('hidden')).toBe(false);

    const closeBtn = modal.querySelector('.modal-close') as HTMLButtonElement;
    dispatch(closeBtn, 'click');
    expect(modal.classList.contains('hidden')).toBe(true);

    await openProjectView(mounted);
    expect(modal.classList.contains('hidden')).toBe(false);
    // Escape bubbles from document up to window, where app.js's own shortcut
    // handler also lives (closeModal on four unrelated modal ids, each
    // kicking off its own fetchBoardState()) — flush so those settle before
    // teardown closes the window out from under them.
    dispatch(doc, 'keydown', { key: 'Escape' });
    await flushPromises();
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});
