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

// A tiny in-memory Agent registry backing /api/v1/command's list_agents /
// register_agent / update_agent / delete_agent, mirroring the real server's
// upsert-by-id / patch-only-present-fields / idempotent-delete semantics
// closely enough to exercise project-view.js's client logic against it.
function installCommandStub(stub: FetchStub, opts: { agents?: any[]; onCommand?: (body: any) => void } = {}) {
  const agents: any[] = opts.agents || [];
  stub.on('POST', '/api/v1/command', ({ body }) => {
    if (opts.onCommand) opts.onCommand(body);
    if (body.type === 'list_agents') {
      return { json: { success: true, data: agents } };
    }
    if (body.type === 'register_agent') {
      const existing = agents.find((a) => a.id === body.payload.id);
      const rec = { type: 'generic', status: 'idle', current_task: null, created_at: new Date().toISOString(), ...body.payload };
      if (existing) Object.assign(existing, rec);
      else agents.push(rec);
      return { json: { success: true, data: rec } };
    }
    if (body.type === 'update_agent') {
      const rec = agents.find((a) => a.id === body.payload.id);
      if (rec) {
        const { id, ...patch } = body.payload;
        Object.assign(rec, patch);
      }
      return { json: { success: true, data: rec || null } };
    }
    if (body.type === 'delete_agent') {
      const idx = agents.findIndex((a) => a.id === body.payload.id);
      if (idx >= 0) agents.splice(idx, 1);
      return { json: { success: true, data: { removed: true, id: body.payload.id } } };
    }
    if (body.type === 'update_project') {
      return { json: { success: true, data: {} } };
    }
    return { json: { success: false, error: `unhandled command ${body.type}` } };
  });
  return agents;
}

function setupBoard(projects: any[], stubExtra?: (stub: FetchStub) => void) {
  const stub = new FetchStub();
  installDefaultRoutes(stub, defaultBoardPayload({ projects }));
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AG: Agent Roles section', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('AG-1: renders above the workflows list, empty state when no adws reference any agent', async () => {
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installCommandStub(stub));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const section = doc.getElementById('pv-agents-section')!;
    const adwHeader = doc.querySelector('.pv-section-header h4')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('agent roles');
    // Agent Roles section must precede the workflows section in DOM order.
    const win = mounted.window as any;
    expect(section.compareDocumentPosition(adwHeader.closest('.pv-section-header')!) & win.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(doc.getElementById('pv-agent-roles-list')!.textContent).toContain('no agent roles referenced');
  });

  it('AG-2: an ADW-referenced agent with no registry entry shows "not yet configured"; Create promotes it to an editable card', async () => {
    const commands: any[] = [];
    const setup = setupBoard([demoProject()], (stub) => installCommandStub(stub, { onCommand: (b) => commands.push(b) }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const list = doc.getElementById('pv-agent-roles-list')!;
    const card = list.querySelector('.pv-agent-card') as HTMLElement;
    expect(card.classList.contains('pv-agent-card-unconfigured')).toBe(true);
    expect(card.dataset.agentId).toBe('coder');
    expect(card.textContent).toContain('not yet configured');

    const createBtn = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Create Agent Role') as HTMLButtonElement;
    dispatch(createBtn, 'click');
    await flushPromises();

    const registerCmd = commands.find((c) => c.type === 'register_agent');
    expect(registerCmd).toBeTruthy();
    expect(registerCmd.payload.name).toBe('coder');
    expect(registerCmd.payload.id).toBeTruthy();

    const updatedCard = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(updatedCard.classList.contains('pv-agent-card-unconfigured')).toBe(false);
    expect(updatedCard.querySelector('.pv-model-picker')).toBeTruthy();
    expect(updatedCard.querySelector('textarea.textarea')).toBeTruthy();
  });

  it('AG-3: editing a configured agent\'s model/prompt debounces a save via update_agent, preserving other fields', async () => {
    const commands: any[] = [];
    const agents = [{ id: 'coder', name: 'coder', model: 'old/model', system_prompt: 'be careful', parameters: [] }];
    const setup = setupBoard([demoProject()], (stub) => installCommandStub(stub, { agents, onCommand: (b) => commands.push(b) }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(card.classList.contains('pv-agent-card-unconfigured')).toBe(false);

    const modelInput = card.querySelector('.pv-model-picker input') as HTMLInputElement;
    modelInput.value = 'new/model';
    dispatch(modelInput, 'input');

    await sleep(700);

    const saveCmd = commands.find((c) => c.type === 'update_agent');
    expect(saveCmd).toBeTruthy();
    expect(saveCmd.payload.id).toBe('coder');
    expect(saveCmd.payload.model).toBe('new/model');
    // system_prompt wasn't touched by this edit but must round-trip unchanged,
    // not be clobbered to empty by the save.
    expect(agents[0].system_prompt).toBe('be careful');
  });

  it('AG-4: deleting a still-referenced agent role reverts its card to "not yet configured" rather than vanishing', async () => {
    const agents = [{ id: 'coder', name: 'coder', model: 'x/y', parameters: [] }];
    const setup = setupBoard([demoProject()], (stub) => installCommandStub(stub, { agents }));
    mounted = setup.mounted;
    const w = mounted.window as any;
    w.confirm = () => true;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const card = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    const delBtn = card.querySelector('.pv-agent-card-header .pv-icon-btn') as HTMLButtonElement;
    dispatch(delBtn, 'click');
    await flushPromises();

    expect(agents.length).toBe(0);
    const after = doc.querySelector('#pv-agent-roles-list .pv-agent-card') as HTMLElement;
    expect(after.classList.contains('pv-agent-card-unconfigured')).toBe(true);
    expect(after.dataset.agentId).toBe('coder');
  });

  it('AG-5: "+ new agent role" creates a draft card; naming it and creating registers a standalone agent not referenced by any ADW', async () => {
    const commands: any[] = [];
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installCommandStub(stub, { onCommand: (b) => commands.push(b) }));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    const addBtn = doc.getElementById('pv-add-agent-btn') as HTMLButtonElement;
    dispatch(addBtn, 'click');
    await flushPromises();

    const draft = doc.querySelector('#pv-agent-roles-list .pv-agent-card-draft') as HTMLElement;
    expect(draft).toBeTruthy();
    const nameInput = draft.querySelector('input') as HTMLInputElement;
    nameInput.value = 'reviewer';
    dispatch(nameInput, 'input');

    const createBtn = Array.from(draft.querySelectorAll('button')).find((b) => b.textContent === 'Create Agent Role') as HTMLButtonElement;
    dispatch(createBtn, 'click');
    await flushPromises();

    const registerCmd = commands.find((c) => c.type === 'register_agent');
    expect(registerCmd).toBeTruthy();
    expect(registerCmd.payload.name).toBe('reviewer');

    const cards = doc.querySelectorAll('#pv-agent-roles-list .pv-agent-card');
    const names = Array.from(cards).map((c) => (c as HTMLElement).dataset.agentId);
    expect(names).toContain('reviewer');
  });
});

describe('DG: Workflow diagram view', () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted) teardown(mounted);
    mounted = null;
  });

  it('DG-1: toggling to "diagram" renders a node per workflow and per referenced agent, list stays hidden', async () => {
    const setup = setupBoard([demoProject()], (stub) => installCommandStub(stub));
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
    const setup = setupBoard([demoProject()], (stub) => installCommandStub(stub));
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
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installCommandStub(stub));
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
    const setup = setupBoard([demoProject({ adws: [] })], (stub) => installCommandStub(stub));
    mounted = setup.mounted;
    await boot(mounted);
    const doc = await openProjectView(mounted);

    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    const diagram = doc.getElementById('pv-adw-diagram')!;
    expect(diagram.querySelector('.wd-empty')).toBeTruthy();
    expect(diagram.textContent).toContain('no workflows registered');
  });

  it('DG-5: reopening the project view always starts back on list view, even if diagram was active last time', async () => {
    const setup = setupBoard([demoProject(), demoProject({ id: 'other', name: 'other', adws: [] })], (stub) => installCommandStub(stub));
    mounted = setup.mounted;
    await boot(mounted);
    let doc = await openProjectView(mounted, 'demo');
    dispatch(doc.querySelector('#pv-adw-view-toggle [data-view="diagram"]') as HTMLElement, 'click');
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(false);

    doc = await openProjectView(mounted, 'other');
    expect(doc.getElementById('pv-adw-list')!.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('pv-adw-diagram')!.classList.contains('hidden')).toBe(true);
  });
});
