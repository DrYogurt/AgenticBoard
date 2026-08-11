import blessed from 'blessed';
import http from 'http';

export function startTUI(workspaceDir: string, serverUrl: string = 'http://localhost:3000'): void {
  const targetUrl = process.env.FACTORY_SERVER_URL || serverUrl;

  const screen = blessed.screen({
    smartCSR: true,
    title: 'AgenticBoard — TUI'
  });

  // Header Box
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: ` {bold}{magenta-fg}AI Software Factory — Interactive Kanban TUI{/magenta-fg}{/bold}\n {dim}Server: ${targetUrl} | Workspace: ${workspaceDir}{/dim}`,
    tags: true,
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  // Main container for columns
  const mainContainer = blessed.box({
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-5',
    style: {
      bg: 'black'
    }
  });

  // Footer Box (Keybindings)
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    content: ' {bold}[Tab/Left/Right]{/bold} Column | {bold}[Up/Down]{/bold} Navigate | {bold}[v/Enter]{/bold} View | {bold}[e]{/bold} Edit | {bold}[n]{/bold} New | {bold}[m]{/bold} Move | {bold}[d]{/bold} Delete | {bold}[r]{/bold} Refresh | {bold}[q]{/bold} Quit',
    tags: true,
    style: {
      fg: 'black',
      bg: 'cyan'
    }
  });

  screen.append(header);
  screen.append(mainContainer);
  screen.append(footer);

  let currentBoard: any = null;
  let currentTasks: any[] = [];
  let currentProjects: any[] = [];
  let columnLists: blessed.Widgets.ListElement[] = [];
  let columnBoxes: blessed.Widgets.BoxElement[] = [];
  let activeColumnIndex = 0;

  async function apiCall(cmdType: string, payload: any = {}): Promise<any> {
    const urlObj = new URL('/api/v1/command', targetUrl);
    const body = JSON.stringify({ type: cmdType, payload });

    return new Promise((resolve, reject) => {
      const req = http.request(
        urlObj,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 3000
        },
        (res) => {
          let rawData = '';
          res.on('data', (chunk) => (rawData += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(rawData);
              if (json && json.success) {
                resolve(json.data);
              } else {
                reject(new Error(json?.error || `Server command ${cmdType} failed`));
              }
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Server timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  async function loadData(): Promise<void> {
    try {
      const data = await apiCall('get_board', {});
      currentBoard = data.board;
      currentTasks = data.tasks;
      currentProjects = data.projects || [];
      renderColumns();
    } catch (err: any) {
      footer.setContent(` {red-fg}Error connecting to server (${targetUrl}): ${err.message}{/red-fg}`);
      screen.render();
    }
  }

  function renderColumns(): void {
    columnBoxes.forEach((box) => box.destroy());
    columnBoxes = [];
    columnLists = [];

    if (!currentBoard || !currentBoard.columns || currentBoard.columns.length === 0) return;

    const cols = currentBoard.columns;
    const colWidthPct = Math.floor(100 / cols.length);
    const taskMap = new Map(currentTasks.map((t) => [t.id, t]));

    cols.forEach((col: any, index: number) => {
      const isFocused = index === activeColumnIndex;
      const box = blessed.box({
        parent: mainContainer,
        left: `${index * colWidthPct}%`,
        width: `${colWidthPct}%`,
        height: '100%',
        label: ` ${col.name} (${(currentBoard?.task_order[col.id] || []).length}) `,
        border: {
          type: 'line'
        },
        style: {
          border: {
            fg: isFocused ? 'cyan' : 'gray'
          },
          label: {
            fg: isFocused ? 'yellow' : 'white',
            bold: true
          }
        }
      });

      const items: string[] = [];
      const taskIds = currentBoard?.task_order[col.id] || [];
      taskIds.forEach((id: string) => {
        const task = taskMap.get(id);
        if (task) {
          const name = task.name || task.title;
          const adw = task.adw ? `{cyan-fg}[${task.adw}]{/cyan-fg}` : '';
          items.push(`[${task.id}] ${name} ${adw}`);
        }
      });

      const list = blessed.list({
        parent: box,
        top: 0,
        left: 0,
        width: '100%-2',
        height: '100%-2',
        items: items,
        tags: true,
        keys: false,
        mouse: true,
        style: {
          selected: {
            bg: 'blue',
            fg: 'white',
            bold: true
          },
          item: {
            fg: 'white'
          }
        }
      });

      if (isFocused && items.length > 0) {
        list.focus();
        list.select(0);
      }

      columnBoxes.push(box);
      columnLists.push(list);
    });

    screen.render();
  }

  // Key navigation
  screen.key(['q', 'C-c'], () => {
    return process.exit(0);
  });

  screen.key(['tab', 'right'], () => {
    if (!currentBoard) return;
    activeColumnIndex = (activeColumnIndex + 1) % currentBoard.columns.length;
    renderColumns();
  });

  screen.key(['S-tab', 'left'], () => {
    if (!currentBoard) return;
    activeColumnIndex = (activeColumnIndex - 1 + currentBoard.columns.length) % currentBoard.columns.length;
    renderColumns();
  });

  screen.key(['up'], () => {
    const list = columnLists[activeColumnIndex];
    if (list) {
      list.up(1);
      screen.render();
    }
  });

  screen.key(['down'], () => {
    const list = columnLists[activeColumnIndex];
    if (list) {
      list.down(1);
      screen.render();
    }
  });

  screen.key(['r'], async () => {
    await loadData();
  });

  // Action: View Task
  screen.key(['v', 'enter'], async () => {
    if (!currentBoard || !columnLists[activeColumnIndex]) return;
    const selectedIdx = (columnLists[activeColumnIndex] as any).selected;
    const currentColId = currentBoard.columns[activeColumnIndex].id;
    const taskIds = currentBoard.task_order[currentColId] || [];
    const targetTaskId = taskIds[selectedIdx];
    if (!targetTaskId) return;

    const taskMap = new Map(currentTasks.map((t) => [t.id, t]));
    const task = taskMap.get(targetTaskId);
    if (!task) return;

    const modal = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: '60%',
      border: { type: 'line' },
      label: ` Task View — [${task.id}] `,
      content: `{bold}ID:{/bold} ${task.id}\n{bold}Name:{/bold} ${task.name || task.title}\n{bold}Status:{/bold} ${task.status}\n{bold}Project:{/bold} ${task.project}\n{bold}ADW:{/bold} ${task.adw}\n\n{bold}Description:{/bold}\n${task.description || '(none)'}\n\n{dim}Press [Escape] or [q] to close{/dim}`,
      tags: true,
      style: {
        border: { fg: 'cyan' },
        label: { fg: 'white', bold: true }
      }
    });

    modal.focus();
    screen.render();

    modal.key(['escape', 'q', 'enter', 'space'], () => {
      modal.destroy();
      screen.render();
    });
  });

  // Action: Edit Task
  screen.key(['e'], async () => {
    if (!currentBoard || !columnLists[activeColumnIndex]) return;
    const selectedIdx = (columnLists[activeColumnIndex] as any).selected;
    const currentColId = currentBoard.columns[activeColumnIndex].id;
    const taskIds = currentBoard.task_order[currentColId] || [];
    const targetTaskId = taskIds[selectedIdx];
    if (!targetTaskId) return;

    const taskMap = new Map(currentTasks.map((t) => [t.id, t]));
    const task = taskMap.get(targetTaskId);
    if (!task) return;

    if (!currentProjects || currentProjects.length === 0) {
      footer.setContent(' {red-fg}Error: Project configuration is required to edit a task.{/red-fg}');
      screen.render();
      return;
    }

    const promptName = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 5,
      border: { type: 'line' },
      label: ` Edit Task [${task.id}] — Name `,
      value: task.name || task.title || '',
      inputOnFocus: true,
      style: {
        border: { fg: 'yellow' },
        label: { fg: 'white', bold: true }
      }
    });

    promptName.focus();
    screen.render();

    promptName.on('submit', async (nameVal: string) => {
      promptName.destroy();
      if (!nameVal || !nameVal.trim()) {
        screen.render();
        return;
      }

      const promptDesc = blessed.textbox({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: 5,
        border: { type: 'line' },
        label: ` Edit Task [${task.id}] — Description `,
        value: task.description || '',
        inputOnFocus: true,
        style: {
          border: { fg: 'yellow' },
          label: { fg: 'white', bold: true }
        }
      });

      promptDesc.focus();
      screen.render();

      promptDesc.on('submit', async (descVal: string) => {
        promptDesc.destroy();
        try {
          await apiCall('update_task', {
            id: task.id,
            name: nameVal.trim(),
            description: (descVal || '').trim()
          });
          await loadData();
        } catch (err: any) {
          footer.setContent(` {red-fg}Error updating task: ${err.message}{/red-fg}`);
          screen.render();
        }
      });

      promptDesc.on('cancel', () => {
        promptDesc.destroy();
        screen.render();
      });
    });

    promptName.on('cancel', () => {
      promptName.destroy();
      screen.render();
    });
  });

  // Action: New Task Prompt (Name, Description, Project, ADW)
  screen.key(['n'], async () => {
    if (!currentBoard) return;
    if (!currentProjects || currentProjects.length === 0) {
      footer.setContent(' {red-fg}Error: Project configuration is required to create a task. No projects configured.{/red-fg}');
      screen.render();
      return;
    }
    const targetCol = currentBoard.columns[activeColumnIndex].id;

    // Prompt for Name
    const promptName = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 5,
      border: { type: 'line' },
      label: ' Create New Task — Step 1/3: Task Name ',
      inputOnFocus: true,
      style: {
        border: { fg: 'green' },
        label: { fg: 'white', bold: true }
      }
    });

    promptName.focus();
    screen.render();

    promptName.on('submit', async (nameVal: string) => {
      promptName.destroy();
      if (!nameVal || !nameVal.trim()) {
        screen.render();
        return;
      }

      // Prompt for Description
      const promptDesc = blessed.textbox({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: 5,
        border: { type: 'line' },
        label: ' Step 2/3: Description (Optional, press Enter) ',
        inputOnFocus: true,
        style: {
          border: { fg: 'green' },
          label: { fg: 'white', bold: true }
        }
      });

      promptDesc.focus();
      screen.render();

      promptDesc.on('submit', async (descVal: string) => {
        promptDesc.destroy();

        const projects = currentProjects;
        
        const projListbar = (blessed.listbar as any)({
          parent: screen,
          top: 'center',
          left: 'center',
          width: '80%',
          height: 3,
          border: { type: 'line' },
          label: ' Step 3/4: Select Project ',
          style: {
            border: { fg: 'green' },
            item: { fg: 'white' },
            selected: { bg: 'green', fg: 'black', bold: true }
          },
          commands: projects.reduce((acc: any, proj: any, idx: number) => {
            acc[`${idx + 1}: ${proj.name || proj.id}`] = {
              keys: [(idx + 1).toString()],
              callback: () => {
                projListbar.destroy();
                const selectedProj = proj;
                const adws = selectedProj.adws && selectedProj.adws.length > 0 ? selectedProj.adws : [{ id: 'implement-feature' }];
                
                const adwListbar = (blessed.listbar as any)({
                  parent: screen,
                  top: 'center',
                  left: 'center',
                  width: '80%',
                  height: 3,
                  border: { type: 'line' },
                  label: ` Step 4/4: Select ADW for '${selectedProj.id}' `,
                  style: {
                    border: { fg: 'green' },
                    item: { fg: 'white' },
                    selected: { bg: 'green', fg: 'black', bold: true }
                  },
                  commands: adws.reduce((acc2: any, adw: any, idx2: number) => {
                    acc2[`${idx2 + 1}: ${adw.id}`] = {
                      keys: [(idx2 + 1).toString()],
                      callback: async () => {
                        adwListbar.destroy();
                        try {
                          await apiCall('create_task', {
                            name: nameVal.trim(),
                            description: (descVal || '').trim(),
                            project: selectedProj.id,
                            adw: adw.id,
                            status: targetCol
                          });
                          await loadData();
                        } catch (err: any) {
                          footer.setContent(` {red-fg}Error creating task: ${err.message}{/red-fg}`);
                          screen.render();
                        }
                      }
                    };
                    return acc2;
                  }, {})
                });
                adwListbar.focus();
                screen.render();
              }
            };
            return acc;
          }, {})
        });

        projListbar.focus();
        screen.render();
      });

      promptDesc.on('cancel', () => {
        promptDesc.destroy();
        screen.render();
      });
    });

    promptName.on('cancel', () => {
      promptName.destroy();
      screen.render();
    });
  });

  // Action: Move Task
  screen.key(['m'], () => {
    if (!currentBoard || !columnLists[activeColumnIndex]) return;
    const selectedIdx = (columnLists[activeColumnIndex] as any).selected;
    const currentColId = currentBoard.columns[activeColumnIndex].id;
    const taskIds = currentBoard.task_order[currentColId] || [];
    const targetTaskId = taskIds[selectedIdx];

    if (!targetTaskId) return;

    const colNames = currentBoard.columns.map((c: any) => c.name);

    const listbar = (blessed.listbar as any)({
      parent: screen,
      bottom: 3,
      left: 'center',
      height: 3,
      border: { type: 'line' },
      label: ` Move Task [${targetTaskId}] to Column `,
      style: {
        border: { fg: 'yellow' },
        item: { fg: 'white' },
        selected: { bg: 'yellow', fg: 'black', bold: true }
      },
      commands: colNames.reduce((acc: any, name: string, idx: number) => {
        acc[`${idx + 1}: ${name}`] = {
          keys: [(idx + 1).toString()],
          callback: async () => {
            listbar.destroy();
            const targetColId = currentBoard!.columns[idx].id;
            try {
              await apiCall('move_task', { id: targetTaskId, target_status: targetColId });
              await loadData();
            } catch (err: any) {
              footer.setContent(` {red-fg}Error moving task: ${err.message}{/red-fg}`);
              screen.render();
            }
          }
        };
        return acc;
      }, {})
    });

    listbar.focus();
    screen.render();
  });

  // Action: Delete Task
  screen.key(['d'], async () => {
    if (!currentBoard || !columnLists[activeColumnIndex]) return;
    const selectedIdx = (columnLists[activeColumnIndex] as any).selected;
    const currentColId = currentBoard.columns[activeColumnIndex].id;
    const taskIds = currentBoard.task_order[currentColId] || [];
    const targetTaskId = taskIds[selectedIdx];

    if (!targetTaskId) return;

    try {
      await apiCall('delete_task', { id: targetTaskId });
      await loadData();
    } catch (err: any) {
      footer.setContent(` {red-fg}Error deleting task: ${err.message}{/red-fg}`);
      screen.render();
    }
  });

  loadData();
}
