const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_ASKPASS = 'echo';

app.use(cors());
app.use(express.json());

const REPOS_DIR = path.join(__dirname, 'repos');
if (!fs.existsSync(REPOS_DIR)) fs.mkdirSync(REPOS_DIR, { recursive: true });

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'flashdeploy',
  user: process.env.DB_USER || 'flashuser',
  password: process.env.DB_PASS || 'flashpass123',
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id VARCHAR(20) PRIMARY KEY,
      repo_url TEXT,
      branch VARCHAR(100),
      status VARCHAR(20),
      container_id TEXT,
      host_port INTEGER,
      project_type VARCHAR(20),
      access_url TEXT,
      expiry VARCHAR(20),
      error_msg TEXT,
      logs TEXT[],
      created_at BIGINT,
      expires_at BIGINT
    )
  `);
  console.log('[DB] Tables ready');
}

const EXPIRY_MS = {
  '7days':  7  * 24 * 60 * 60 * 1000,
  '30days': 30 * 24 * 60 * 60 * 1000,
  '90days': 90 * 24 * 60 * 60 * 1000,
};

function detectType(repoPath) {
  if (fs.existsSync(path.join(repoPath, 'Dockerfile'))) return 'docker';
  if (fs.existsSync(path.join(repoPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
      const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      if (deps.react || deps.next || deps.vite) return 'react';
    } catch (e) {}
    return 'node';
  }
  if (fs.existsSync(path.join(repoPath, 'requirements.txt'))) return 'python';
  return 'static';
}

function getStartCmd(repoPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.start) return pkg.scripts.start;
    if (pkg.main) return 'node ' + pkg.main;
  } catch (e) {}
  return 'node index.js';
}

function generateDockerfile(type, repoPath) {
  const dfPath = path.join(repoPath, 'Dockerfile.flash');
  let lines = [];
  if (type === 'node') {
    const cmd = getStartCmd(repoPath);
    lines = [
      'FROM node:20-alpine','WORKDIR /app','COPY package*.json ./','RUN npm install',
      'COPY . .','EXPOSE 3000','CMD ["sh", "-c", "' + cmd + '"]'
    ];
  } else if (type === 'react') {
    lines = [
      'FROM node:20-alpine AS builder','WORKDIR /app','COPY package*.json ./','RUN npm install',
      'COPY . .','RUN npm run build','FROM nginx:alpine',
      'COPY --from=builder /app/build /usr/share/nginx/html','EXPOSE 80',
      'CMD ["nginx", "-g", "daemon off;"]'
    ];
  } else if (type === 'python') {
    lines = [
      'FROM python:3.11-slim','WORKDIR /app','COPY requirements.txt .',
      'RUN pip install -r requirements.txt','COPY . .','EXPOSE 8000',
      'CMD ["sh", "-c", "python app.py 2>/dev/null || python main.py"]'
    ];
  } else {
    lines = ['FROM nginx:alpine','COPY . /usr/share/nginx/html','EXPOSE 80','CMD ["nginx", "-g", "daemon off;"]'];
  }
  fs.writeFileSync(dfPath, lines.join('\n'));
  return dfPath;
}

function randomPort() {
  return Math.floor(Math.random() * (9000 - 5100 + 1)) + 5100;
}

async function addLog(id, msg) {
  const entry = '[' + new Date().toISOString() + '] ' + msg;
  await pool.query('UPDATE deployments SET logs = array_append(logs, $1) WHERE id=$2', [entry, id]);
  console.log('[' + id + '] ' + msg);
}

function formatDep(row) {
  return {
    id: row.id, repoUrl: row.repo_url, branch: row.branch, status: row.status,
    containerId: row.container_id, hostPort: row.host_port, projectType: row.project_type,
    accessUrl: row.access_url, expiry: row.expiry, errorMsg: row.error_msg,
    logs: row.logs || [], createdAt: Number(row.created_at), expiresAt: Number(row.expires_at)
  };
}

function buildCloneUrl(repoUrl, token) {
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    u.username = token;
    u.password = 'x-oauth-basic';
    return u.toString();
  } catch(e) { return repoUrl; }
}

function getIntPort(projectType) {
  if (projectType === 'react' || projectType === 'static') return '80';
  if (projectType === 'python') return '8000';
  return '3000';
}

// nip.io subdomain URL - no port in URL!
function buildAccessUrl(serverIP, hostPort, projectType) {
  const ipDash = serverIP.replace(/\./g, '-');
  // nip.io maps port.ip-dash.nip.io -> ip:port
  return 'http://' + hostPort + '.' + ipDash + '.nip.io';
}

async function cleanupExpired() {
  try {
    const now = Date.now();
    const r = await pool.query('SELECT * FROM deployments WHERE expires_at < $1', [now]);
    for (const row of r.rows) {
      try {
        if (row.container_id) {
          const c = docker.getContainer(row.container_id);
          await c.stop().catch(() => {});
          await c.remove().catch(() => {});
        }
        const rp = path.join(REPOS_DIR, row.id);
        if (fs.existsSync(rp)) fs.rmSync(rp, { recursive: true });
        await pool.query('DELETE FROM deployments WHERE id=$1', [row.id]);
        console.log('[CLEANUP] ' + row.id);
      } catch (e) {
        console.error('[CLEANUP ERROR]', row.id, e.message);
      }
    }
  } catch (e) {
    console.error('[CLEANUP]', e.message);
  }
}
setInterval(cleanupExpired, 60 * 60 * 1000);

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.get('/deployments', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments ORDER BY created_at DESC');
    res.json(r.rows.map(formatDep));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/deployments/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(formatDep(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/deployments/:id/logs', async (req, res) => {
  try {
    const r = await pool.query('SELECT logs FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ logs: r.rows[0].logs || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update ENV and restart container
app.post('/deployments/:id/env', async (req, res) => {
  try {
    const { envVars = {} } = req.body;
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];
    if (!dep.container_id) return res.status(400).json({ error: 'No container found' });

    const c = docker.getContainer(dep.container_id);
    const info = await c.inspect();
    const existingEnv = info.Config.Env || [];

    const newEnvEntries = Object.entries(envVars).map(([k,v]) => k + '=' + v);
    const mergedEnv = [
      ...existingEnv.filter(e => {
        const key = e.split('=')[0];
        return !Object.keys(envVars).includes(key);
      }),
      ...newEnvEntries
    ];

    await c.stop().catch(() => {});
    await c.remove().catch(() => {});

    const imgName = 'flash-' + dep.id;
    const intPort = getIntPort(dep.project_type);
    const portBindings = {};
    portBindings[intPort + '/tcp'] = [{ HostPort: String(dep.host_port) }];
    const exposedPorts = {};
    exposedPorts[intPort + '/tcp'] = {};

    const container = await docker.createContainer({
      Image: imgName,
      name: 'flash-' + dep.id,
      Env: mergedEnv,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1000000000,
        RestartPolicy: { Name: 'unless-stopped' }
      }
    });

    await container.start();
    await pool.query('UPDATE deployments SET container_id=$1, status=$2 WHERE id=$3', [container.id, 'live', dep.id]);
    await addLog(dep.id, 'ENV updated and container restarted');
    res.json({ success: true, message: 'ENV updated and restarted!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/deployments/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];
    if (dep.container_id) {
      const c = docker.getContainer(dep.container_id);
      await c.stop().catch(() => {});
      await c.remove().catch(() => {});
    }
    const rp = path.join(REPOS_DIR, req.params.id);
    if (fs.existsSync(rp)) fs.rmSync(rp, { recursive: true });
    await pool.query('DELETE FROM deployments WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/deploy', async (req, res) => {
  const { repoUrl, branch = 'main', expiry = '30days', token = '', envVars = {} } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const id = uuidv4().split('-')[0];
  const repoPath = path.join(REPOS_DIR, id);
  const imgName = 'flash-' + id;
  const hostPort = randomPort();
  const expiryMs = EXPIRY_MS[expiry] || EXPIRY_MS['30days'];
  const now = Date.now();

  await pool.query(
    `INSERT INTO deployments (id, repo_url, branch, status, host_port, expiry, logs, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, repoUrl, branch, 'building', hostPort, expiry, [], now, now + expiryMs]
  );

  res.json({ id, status: 'building', message: 'Deployment started!' });

  (async () => {
    try {
      const cloneUrl = buildCloneUrl(repoUrl, token);
      await addLog(id, 'Cloning ' + repoUrl + ' (branch: ' + branch + ')');
      await simpleGit({ binary: '/usr/bin/git' })
        .clone(cloneUrl, repoPath, ['--branch', branch, '--depth', '1']);
      await addLog(id, 'Clone successful');

      const type = detectType(repoPath);
      await addLog(id, 'Project type: ' + type);

      const dfFlag = type !== 'docker' ? '-f Dockerfile.flash' : '';
      generateDockerfile(type, repoPath);

      const envArgs = Object.entries(envVars).map(([k,v]) => '--build-arg ' + k + '=' + v).join(' ');

      await addLog(id, 'Building Docker image...');
      execSync('docker build ' + dfFlag + ' ' + envArgs + ' -t ' + imgName + ' .', {
        cwd: repoPath, stdio: 'pipe', timeout: 300000
      });
      await addLog(id, 'Docker image built successfully');

      const intPort = getIntPort(type);
      const portBindings = {};
      portBindings[intPort + '/tcp'] = [{ HostPort: String(hostPort) }];
      const exposedPorts = {};
      exposedPorts[intPort + '/tcp'] = {};

      // PORT = internal container port (3000/80/8000) - NOT host port!
      const envArray = [
        'PORT=' + intPort,
        ...Object.entries(envVars).map(([k,v]) => k + '=' + v)
      ];

      const container = await docker.createContainer({
        Image: imgName,
        name: 'flash-' + id,
        Env: envArray,
        ExposedPorts: exposedPorts,
        HostConfig: {
          PortBindings: portBindings,
          Memory: 512 * 1024 * 1024,
          NanoCpus: 1000000000,
          RestartPolicy: { Name: 'unless-stopped' }
        }
      });

      await container.start();
      await addLog(id, 'Container started on port ' + hostPort);

      const serverIP = process.env.SERVER_IP || '34.201.132.220';
      const accessUrl = buildAccessUrl(serverIP, hostPort, type);

      await pool.query(
        `UPDATE deployments SET status=$1, container_id=$2, project_type=$3, access_url=$4 WHERE id=$5`,
        ['live', container.id, type, accessUrl, id]
      );
      await addLog(id, 'LIVE at ' + accessUrl);

    } catch (err) {
      await pool.query(
        'UPDATE deployments SET status=$1, error_msg=$2 WHERE id=$3',
        ['failed', err.message, id]
      );
      console.error('[FAIL]', id, err.message);
    }
  })();
});

const PORT = parseInt(process.env.PORT) || 5000;
initDB()
  .then(() => app.listen(PORT, () => console.log('[OK] FlashDeploy backend on port ' + PORT)))
  .catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
