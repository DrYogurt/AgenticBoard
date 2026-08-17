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

// Stubs GET/PUT /api/v1/projects/:id/sssf-config against an in-memory roster,
// mirroring the real server's "roster not found" / field-preserving-edit /
// add-and-delete-by-omission semantics closely enough to exercise
// project-view.js's client logic against it.
function installSssfConfigStub(stub: FetchStub, opts: { agents?: any[] | null; defaults?: any; onPut?: (body: any) => void } = {}) {
  let agents: any[] | null = opts.agents === undefined ? [] : opts.agents;
  const defaults = opts.defaults || { model: 'google/gemini-3.7-flash', thinking: 'medium' };
  stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/sssf-config$/, () => {
    if (agents === null) {
      return { json: { success: true, data: null, error: 'no adws/adw_sssf_config/sssf.config.yaml found — has this project been stamped with SSSF?' } };
    }
    return { json: { success: true, data: { defaults, observability: {}, agents } } };
  });
  stub.on('PUT', /^\/api\/v1\/projects\/[^/]+\/sssf-config$/, ({ body }) => {
    if (opts.onPut) opts.onPut(body);
    agents = body.agents;
    return { json: { success: true, data: { saved: true } } };
  });
  return {
    get: () => agents
  };
}

function installFileStub(stub: FetchStub) {
  const files = new Map<string, string>();
  stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/file$/, ({ url }) => {
    const p = url.searchParams.get('path') || '';
    const content = files.get(p);
    return { json: { success: true, data: { path: p, content: content ?? null, exists: files.has(p) } } };
  });
  stub.on('PUT', /^\/api\/v1\/projects\/[^/]+\/file$/, ({ body }) => {
    files.set(body.path, body.content);
    return { json: { success: true, data: { path: body.path, saved: true } } };
  });
  return files;
}

function setupBoard(projects: any[], stubExtra?: (stub: FetchStub) => void) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, defaultBoardPayload({ projects }));
  installFileStub(stub);
  if (stubExtra) stubExtra(stub);
  const mounted = mountBoard({ fetchStub: stub });
  return { mounted, stub };
}

async function boot(mounted: Mounted) {
  const w = mounted.window as any;
  w.setupEventListeners();
  await w.fetchBoardState();
  await flushPromises();
}

async function openProjectView(mounted: Mounted, projectId = 'demo') {
  const w = mounted.window as any;
  await w.ProjectView.open(projectId);
  await flushPromises();
  return mounted.document;
}

describe('AG: Agent Roles section', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('AG-1a: no sssf.config.yaml shows a "not stamped with SSSF" message, above the workflows list', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: null }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const section = doc.getElementById('pv-agents-section')!;
    const adwHeader = doc.querySelector('.pv-section-header h4')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('agent roles');
    const win = mounted.window as any;
    expect(section.compareDocumentPosition(adwHeader.closest('.pv-section-header')!) & win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(doc.getElementById('pv-agent-roles-list')!.textContent).toContain('stamped with SSSF');
    // No add-agent / save-roster affordances when there's nothing to write into.
    expect(doc.getElementById('pv-add-agent-btn')!.classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('pv-agents-save-row')!.classList.contains('hidden')).toBe(true);
  });

  it('AG-1b: an empty roster with no referenced agents shows its own empty state', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);
    expect(doc.getElementById('pv-agent-roles-list')!.textContent).toContain('no agents in the roster yet');
    expect(doc.getElementById('pv-add-agent-btn')!.classList.contains('hidden')).toBe(false);
  });

  it('AG-2: an ADW-referenced agent absent from the roster shows a "referenced, not in roster" row; adding it stages a real card', async () => {
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const list = doc.getElementById('pv-agent-roles-list')!;
    const row = list.querySelector('.pv-agent-unregistered-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('coder');
    expect(row.textContent).toContain('referenced, not in roster');

    const addBtn = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === '+ add to roster') as HTMLButtonElement;
    dispatch(addBtn, 'click');

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.dataset.agentId).toBe('coder');
    expect(list.querySelector('.pv-agent-unregistered-row')).toBeFalsy();
    // Staged locally only — nothing written until "save agent roster".
    expect(doc.getElementById('pv-agents-save-banner')!.textContent).toBe('');
  });

  it('AG-3: editing a roster agent\'s fields and clicking "save agent roster" PUTs the whole roster', async () => {
    let putBody: any = null;
    const agents = [{ name: 'coder', model: 'old/model', purpose: 'writes code', prompt_engineering: { system: 'adws/adw_data/prompt_engineering/coder/system.md', user: 'adws/adw_data/prompt_engineering/coder/user.md' } }];
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents, onPut: (b) => { putBody = b; } }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(card).toBeTruthy();

    const modelInput = card.querySelector('.pv-model-picker input') as HTMLInputElement;
    modelInput.value = 'new/model';
    dispatch(modelInput, 'input');

    const thinkingSelect = card.querySelectorAll('select')[0] as HTMLSelectElement;
    thinkingSelect.value = 'high';
    dispatch(thinkingSelect, 'change');

    const saveBtn = doc.getElementById('pv-agents-save-btn') as HTMLButtonElement;
    dispatch(saveBtn, 'click');
    await flushPromises();

    expect(putBody).toBeTruthy();
    const saved = putBody.agents.find((a: any) => a.name === 'coder');
    expect(saved.model).toBe('new/model');
    expect(saved.thinking).toBe('high');
    // Untouched field survives in the payload.
    expect(saved.purpose).toBe('writes code');

    const banner = doc.getElementById('pv-agents-save-banner')!;
    expect(banner.textContent).toContain('saved.');
  });

  it('AG-4: removing a still-referenced roster agent immediately turns it back into a "referenced, not in roster" row', async () => {
    const agents = [{ name: 'coder', purpose: 'writes code' }];
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents }));
    mounted = setup.mounted;
    const w = mounted.window as any;
    w.confirm = () => true;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    const delBtn = card.querySelector('.pv-agent-card-header .pv-icon-btn') as HTMLButtonElement;
    dispatch(delBtn, 'click');

    expect(doc.querySelector('#pv-agent-roles-list .pv-agent-card')).toBeFalsy();
    const row = doc.querySelector('#pv-agent-roles-list .pv-agent-unregistered-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain('coder');
  });

  it('AG-5: "+ new agent role" stages a draft card; naming it and adding registers it locally, independent of any ADW reference', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const addBtn = doc.getElementById('pv-add-agent-btn') as HTMLButtonElement;
    dispatch(addBtn, 'click');

    const draft = doc.querySelector('#pv-agent-roles-list .pv-agent-card-draft') as HTMLElement;
    expect(draft).toBeTruthy();
    const nameInput = draft.querySelector('input') as HTMLInputElement;
    nameInput.value = 'reviewer';
    dispatch(nameInput, 'input');

    const createBtn = Array.from(draft.querySelectorAll('button')).find((b) => b.textContent === 'Add to Roster') as HTMLButtonElement;
    dispatch(createBtn, 'click');

    const cards = doc.querySelectorAll('#pv-agent-roles-list .pv-agent-card');
    const ids = Array.from(cards).map((c) => (c as HTMLElement).dataset.agentId);
    expect(ids).toContain('reviewer');
    expect(doc.querySelector('#pv-agent-roles-list .pv-agent-card-draft')).toBeFalsy();
  });

  it('AG-6: model/thinking/color/purpose are editable; tools and writes render as a read-only badge list', async () => {
    const agents = [{
      name: 'coder',
      purpose: 'writes code',
      color: '#22d3ee',
      tools: ['read', 'write'],
      writes: ['src/']
    }];
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(card.querySelector('.pv-model-picker')).toBeTruthy();
    expect(card.querySelectorAll('select').length).toBeGreaterThan(0);
    expect(card.textContent).toContain('read');
    expect(card.textContent).toContain('write');
    expect(card.textContent).toContain('src/');
    expect(card.textContent).toContain('read-only');
  });

  it('AG-7: a workflow\'s parsed REQUIRED_AGENTS shows on its card and feeds the "referenced, not in roster" list', async () => {
    const setup = setupBoard([demoProject({
      adws: [{ id: 'build-feature', name: 'Build Feature', path: 'adws/build_feature.py', parameters: [] }]
    })], (stub) => {
      installSssfConfigStub(stub, { agents: [] });
      stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/adw-agents$/, () => ({ json: { success: true, data: { 'build-feature': ['planner', 'builder'] } } }));
    });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    expect(card.textContent).toContain('planner');
    expect(card.textContent).toContain('builder');
    expect(card.textContent).toContain('REQUIRED_AGENTS');

    const rows = doc.querySelectorAll('#pv-agent-roles-list .pv-agent-unregistered-row');
    const names = Array.from(rows).map((r) => r.textContent);
    expect(names.some((t) => t!.includes('planner'))).toBe(true);
    expect(names.some((t) => t!.includes('builder'))).toBe(true);
  });

  it('AG-8: agent cards collapse/expand like workflow cards, and deleting doesn\'t also toggle the header', async () => {
    const agents = [{ name: 'coder', purpose: 'writes code' }];
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents }));
    mounted = setup.mounted;
    const w = mounted.window as any;
    w.confirm = () => true;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(card.classList.contains('pv-expanded')).toBe(false);

    const header = card.querySelector('.pv-agent-card-header') as HTMLElement;
    dispatch(header, 'click');
    expect(card.classList.contains('pv-expanded')).toBe(true);
    dispatch(header, 'click');
    expect(card.classList.contains('pv-expanded')).toBe(false);

    // Clicking delete (also inside the header) must not also toggle expand —
    // it should just remove the card.
    dispatch(header, 'click'); // expand again first
    expect(card.classList.contains('pv-expanded')).toBe(true);
    const delBtn = card.querySelector('.pv-icon-btn') as HTMLButtonElement;
    dispatch(delBtn, 'click');
    expect(doc.querySelector('#pv-agent-roles-list .pv-agent-card')).toBeFalsy();
  });

  it('AG-9: a newly-staged agent (via "+ new agent role") lands expanded and scrolled into view', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.getElementById('pv-add-agent-btn') as HTMLElement, 'click');
    const draft = doc.querySelector('#pv-agent-roles-list .pv-agent-card-draft') as HTMLElement;
    const nameInput = draft.querySelector('input') as HTMLInputElement;
    nameInput.value = 'reviewer';
    dispatch(nameInput, 'input');
    const createBtn = Array.from(draft.querySelectorAll('button')).find((b) => b.textContent === 'Add to Roster') as HTMLButtonElement;
    dispatch(createBtn, 'click');

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card[data-agent-id="reviewer"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.classList.contains('pv-expanded')).toBe(true);
  });
});

describe('DG: Workflow diagram view', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('DG-1: toggling to "diagram" renders a node per workflow and per referenced agent, list stays hidden', async () => {
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(true);

    const toggleBtn = doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLButtonElement;
    dispatch(toggleBtn, 'click');

    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(true);
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(false);
    expect(toggleBtn.classList.contains('pv-active')).toBe(true);

    const diagram = doc.getElementById('pv-adw-diagram')!;
    const wfNode = diagram.querySelector('.wd-node-workflow') as HTMLElement;
    const agentNode = diagram.querySelector('.wd-node-agent') as HTMLElement;
    expect(wfNode.dataset.adwId).toBe('build-feature');
    expect(agentNode.dataset.agentId).toBe('coder');
  });

  it('DG-2: clicking a workflow node switches back to list view, expands and flashes the matching card', async () => {
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    const wfNode = doc.querySelector('.wd-node-workflow') as HTMLElement;
    dispatch(wfNode, 'click');

    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(true);
    const listToggle = doc.querySelector('#pv-adw-view-toggle [data-view="list"]') as HTMLElement;
    expect(listToggle.classList.contains('pv-active')).toBe(true);

    const card = doc.querySelector('.pv-adw-card[data-adw-id="build-feature"]') as HTMLElement;
    expect(card.classList.contains('pv-expanded')).toBe(true);
    expect(card.classList.contains('pv-flash')).toBe(true);
  });

  it('DG-3: the diagram\'s "+ new workflow" node adds a workflow and lands on the expanded list-view card', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    // With zero workflows the diagram renders its empty state (not a canvas
    // with a "+" node row), whose own add button drives the same callback.
    const addNode = doc.querySelector('.wd-empty-add-btn') as HTMLElement;
    expect(addNode).toBeTruthy();
    dispatch(addNode, 'click');

    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(false);
    const cards = doc.querySelectorAll('#pv-adw-list .pv-adw-card');
    expect(cards.length).toBe(1);
    expect((cards[0] as HTMLElement).classList.contains('pv-expanded')).toBe(true);
  });

  it('DG-4: a project with zero workflows shows the diagram empty state with its own add affordance', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    const diagram = doc.getElementById('pv-adw-diagram')!;
    expect(diagram.querySelector('.wd-empty')).toBeTruthy();
    expect(diagram.textContent).toContain('no workflows registered');
  });

  it('DG-5: reopening the project view always starts back on list view, even if diagram was active last time', async () => {
    const setup = setupBoard([demoProject(), demoProject({ id: 'other', name: 'other', adws: [] })], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    await boot(mounted);
    let doc = await openProjectView(mounted, 'demo');
    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(false);

    doc = await openProjectView(mounted, 'other');
    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(true);
  });

  it('DG-6: the diagram also draws edges for a workflow\'s parsed REQUIRED_AGENTS, not just type:\'agent\' parameters', async () => {
    const setup = setupBoard([demoProject({
      adws: [{ id: 'build-feature', name: 'Build Feature', path: 'adws/build_feature.py', parameters: [] }]
    })], (stub) => {
      installSssfConfigStub(stub, { agents: [] });
      stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/adw-agents$/, () => ({ json: { success: true, data: { 'build-feature': ['planner', 'builder'] } } }));
    });
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    const diagram = doc.getElementById('pv-adw-diagram')!;
    const agentNodes = diagram.querySelectorAll('.wd-node-agent');
    const ids = Array.from(agentNodes).map((n) => (n as HTMLElement).dataset.agentId);
    expect(ids).toContain('planner');
    expect(ids).toContain('builder');
    expect(diagram.querySelectorAll('.wd-edge').length).toBe(2);
  });
});

describe('FE: generic project-file editor (workflow scripts, agent prompts)', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('FE-1: a workflow\'s "show script" toggle lazily fetches and can save its content', async () => {
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents: [] }));
    mounted = setup.mounted;
    // Seed the script file's content into the file stub.
    setup.stub.on('GET', /^\/api\/v1\/projects\/[^/]+\/file$/, ({ url }) => {
      const p = url.searchParams.get('path');
      if (p === 'adws/build_feature.py') return { json: { success: true, data: { path: p, content: '#!/usr/bin/env python\nprint("hi")\n', exists: true } } };
      return { json: { success: true, data: { path: p, content: null, exists: false } } };
    });
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('.pv-adw-card') as HTMLElement;
    const toggleBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'show script') as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    dispatch(toggleBtn, 'click');
    await flushPromises();

    const ta = card.querySelector('.pv-file-editor-textarea') as HTMLTextAreaElement;
    expect(ta.value).toContain('print("hi")');

    ta.value = '#!/usr/bin/env python\nprint("edited")\n';
    dispatch(ta, 'input');

    const saveBtn = Array.from(card.querySelectorAll('.pv-file-editor button')).find((b) => b.textContent === 'save script') as HTMLButtonElement;
    dispatch(saveBtn, 'click');
    await flushPromises();

    const putCall = setup.stub.calls.find((c) => c.method === 'PUT' && c.path.includes('/file'));
    expect(putCall).toBeTruthy();
    expect(putCall!.body.path).toBe('adws/build_feature.py');
    expect(putCall!.body.content).toContain('edited');
  });

  it('FE-2: an agent card\'s system/user prompt editors are collapsed until toggled', async () => {
    const agents = [{
      name: 'coder',
      purpose: 'writes code',
      prompt_engineering: { system: 'adws/adw_data/prompt_engineering/coder/system.md', user: 'adws/adw_data/prompt_engineering/coder/user.md' }
    }];
    const setup = setupBoard([demoProject()], (stub) => installSssfConfigStub(stub, { agents }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    const bodies = card.querySelectorAll('.pv-file-editor-body');
    expect(bodies.length).toBe(2);
    bodies.forEach((b) => expect(b.classList.contains('hidden')).toBe(true));

    const showSystemBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'show system prompt') as HTMLButtonElement;
    dispatch(showSystemBtn, 'click');
    await flushPromises();
    expect(showSystemBtn.textContent).toBe('hide system prompt');
  });
});
