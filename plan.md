# AgenticBoard — Architecture & Component Plan

## Overview
AgenticBoard is a modular, deterministic Kanban software factory system divided into three independent, containerizable Node.js projects.

## Component Architecture

Each component is a fully independent Node.js project with its own `package.json`, `node_modules/`, `tsconfig.json`, build scripts, and Dockerfile.

```
AgenticBoard/
├── server/               # 1. Backend Server, Core Engine & CLI
│   ├── package.json      # Independent npm project
│   ├── tsconfig.json     # TypeScript configuration
│   ├── index.ts          # Express BoardServer daemon & SSE stream
│   ├── Dockerfile        # Server container build specification
│   ├── core/             # DeterministicEngine, storage, validator, schemas
│   ├── cli/              # CLI commands and factory.js binary runner
│   ├── tests/            # All backend tests (engine, server, validator, cli, web)
│   ├── board.json        # Workspace board data persistence
│   ├── tasks/            # Task record persistence
│   └── projects/         # Project persistence
├── website/              # 2. Web UI Frontend Client
│   ├── package.json      # Independent npm project (http-server for dev)
│   ├── Dockerfile        # Nginx-based container build specification
│   ├── nginx.conf        # Production Nginx reverse proxy configuration
│   └── public/           # Static assets (index.html, app.js, styles.css, favicons)
├── tui/                  # 3. Terminal User Interface
│   ├── package.json      # Independent npm project
│   ├── tsconfig.json     # TypeScript configuration
│   ├── index.ts          # Blessed interactive terminal application
│   ├── Dockerfile        # TUI container build specification
│   └── core/             # Replicated core engine (engine, storage, validator, schemas)
├── docker-compose.yml    # Multi-container orchestration (server, website, tui)
└── plan.md               # This file — architecture specification
```

## Running Each Component

### Server (Backend)
```bash
cd server
npm install
npm run dev    # Development with tsx hot reload
npm start      # Production (requires npm run build first)
npm test       # Run all backend tests
```

### Website (Frontend)
```bash
cd website
npm install
npm run dev    # Local dev server on port 8080
```

### TUI (Terminal Interface)
```bash
cd tui
npm install
npm run dev    # Development with tsx
npm start      # Production (requires npm run build first)
```

### Docker Compose (Full Stack)
```bash
docker-compose up --build
```
