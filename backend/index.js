const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');
const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const crypto = require('crypto');

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
      container_ids JSONB,
      host_port INTEGER,
      project_type VARCHAR(20),
      access_url TEXT,
      services JSONB,
      expiry VARCHAR(20),
      error_msg TEXT,
      logs TEXT[],
      created_at BIGINT,
      expires_at BIGINT,
      dockerfile_path VARCHAR(200),
      root_directory VARCHAR(200),
      start_command TEXT,
      healthcheck_path VARCHAR(200),
      restart_policy VARCHAR(50),
      webhook_secret VARCHAR(100),
      cron_schedule VARCHAR(100),
      compose_file VARCHAR(200),
      env_vars JSONB
    )
  `);
  const cols = [
    'compose_file VARCHAR(200)', 'services JSONB', 'container_ids JSONB',
    'dockerfile_path VARCHAR(200)', 'root_directory VARCHAR(200)', 'start_command TEXT',
    'healthcheck_path VARCHAR(200)', 'restart_policy VARCHAR(50)', 'webhook_secret VARCHAR(100)',
    'cron_schedule VARCHAR(100)', 'env_vars JSONB'
  ];
  for (const col of cols) {
    await pool.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${col}`).catch(()=>{});
  }
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

function getStartCmd(repoPath, customStartCommand) {
  if (customStartCommand) return customStartCommand;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.start) return pkg.scripts.start;
    if (pkg.main) return 'node ' + pkg.main;
  } catch (e) {}
  return 'node index.js';
}

function generateDockerfile(type, repoPath, customStartCommand) {
  const dfPath = path.join(repoPath, 'Dockerfile.flash');
  let lines = [];
  if (type === 'node') {
    const cmd = getStartCmd(repoPath, customStartCommand);
    lines = ['FROM node:20-alpine','WORKDIR /app','COPY package*.json ./','RUN npm install','COPY . .','EXPOSE 3000','CMD ["sh", "-c", "' + cmd + '"]'];
  } else if (type === 'react') {
    lines = ['FROM node:20-alpine AS builder','WORKDIR /app','COPY package*.json ./','RUN npm install','COPY . .','RUN npm run build','FROM nginx:alpine','COPY --from=builder /app/build /usr/share/nginx/html','EXPOSE 80','CMD ["nginx", "-g", "daemon off;"]'];
  } else if (type === 'python') {
    const cmd = customStartCommand || 'python app.py 2>/dev/null || python main.py';
    lines = ['FROM python:3.11-slim','WORKDIR /app','COPY requirements.txt .','RUN pip install -r requirements.txt','COPY . .','EXPOSE 8000','CMD ["sh", "-c", "' + cmd + '"]'];
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
    containerId: row.container_id, containerIds: row.container_ids || {},
    hostPort: row.host_port, projectType: row.project_type,
    accessUrl: row.access_url, services: row.services || {},
    expiry: row.expiry, errorMsg: row.error_msg,
    logs: row.logs || [], createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    dockerfilePath: row.dockerfile_path || '',
    rootDirectory: row.root_directory || '',
    startCommand: row.start_command || '',
    healthcheckPath: row.healthcheck_path || '',
    restartPolicy: row.restart_policy || 'unless-stopped',
    webhookSecret: row.webhook_secret || '',
    cronSchedule: row.cron_schedule || '',
    composeFile: row.compose_file || '',
    envVars: row.env_vars || {}
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

function buildAccessUrl(serverIP, hostPort) {
  return 'http://' + serverIP + ':' + hostPort;
}

function getRestartPolicy(policy) {
  const map = {
    'always': { Name: 'always' },
    'never': { Name: 'no' },
    'on-failure': { Name: 'on-failure', MaximumRetryCount: 10 },
    'unless-stopped': { Name: 'unless-stopped' }
  };
  return map[policy] || map['unless-stopped'];
}

function hasComposeFile(repoPath, composeFile) {
  const composePath = composeFile
    ? path.join(repoPath, composeFile.replace(/^\//, ''))
    : path.join(repoPath, 'docker-compose.yml');
  return fs.existsSync(composePath) ? composePath : null;
}

// Get all running containers for a compose project
async function getComposeContainers(projectName) {
  try {
    const containers = await docker.listContainers({ all: false });
    return containers.filter(c => {
      const labels = c.Labels || {};
      return labels['com.docker.compose.project'] === projectName;
    });
  } catch(e) { return []; }
}

async function deployWithCompose(id, repoPath, composePath, envVars, restartPolicy) {
  const serverIP = process.env.SERVER_IP || '34.201.132.220';
  const projectName = 'flash' + id;

  await addLog(id, 'Detected docker-compose.yml - using compose deployment');

  // Write env file
  if (envVars && Object.keys(envVars).length > 0) {
    const envLines = Object.entries(envVars).map(([k,v]) => k + '=' + v);
    fs.writeFileSync(path.join(repoPath, '.env'), envLines.join('\n'));
    await addLog(id, 'ENV file written with ' + Object.keys(envVars).length + ' variables');
  }

  // Get service names
  const composeContent = fs.readFileSync(composePath, 'utf8');
  const serviceNames = [];
  const lines = composeContent.split('\n');
  let inServices = false;
  for (const line of lines) {
    if (line.trim() === 'services:') { inServices = true; continue; }
    if (inServices && line.match(/^  \w+:/) && !line.match(/^\s{4}/)) {
      const name = line.trim().replace(':', '');
      if (!['volumes', 'networks'].includes(name)) serviceNames.push(name);
    }
    if (inServices && line.match(/^(volumes|networks):/) && !line.match(/^  /)) inServices = false;
  }

  await addLog(id, 'Services found: ' + serviceNames.join(', '));

  execSync('docker-compose -p ' + projectName + ' -f ' + composePath + ' build', {
    cwd: repoPath, stdio: 'pipe', timeout: 600000
  });
  await addLog(id, 'Compose build successful');

  execSync('docker-compose -p ' + projectName + ' -f ' + composePath + ' up -d --force-recreate', {
    cwd: repoPath, stdio: 'pipe', timeout: 120000
  });
  await addLog(id, 'Compose services started');

  // Wait a bit for containers to start
  await new Promise(r => setTimeout(r, 3000));

  // Get containers via docker API using compose labels
  const runningContainers = await getComposeContainers(projectName);

  const services = {};
  const containerIds = {};
  let mainUrl = '';

  for (const c of runningContainers) {
    const svcName = (c.Labels || {})['com.docker.compose.service'] || 'unknown';
    containerIds[svcName] = c.Id;

    const ports = c.Ports || [];
    for (const p of ports) {
      if (p.PublicPort && p.IP === '0.0.0.0') {
        const url = buildAccessUrl(serverIP, p.PublicPort);
        services[svcName] = { url, hostPort: p.PublicPort, intPort: p.PrivatePort };
        if (!mainUrl) mainUrl = url;
        await addLog(id, svcName + ' running at ' + url + ' (port ' + p.PublicPort + ')');
        break;
      }
    }
  }

  if (!mainUrl && runningContainers.length > 0) {
    await addLog(id, 'Containers started but no public ports found - check docker-compose.yml ports config');
  }

  return { services, containerIds, mainUrl };
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
        if (row.container_ids) {
          for (const [svc, cid] of Object.entries(row.container_ids)) {
            const c = docker.getContainer(cid);
            await c.stop().catch(() => {});
            await c.remove().catch(() => {});
          }
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

const cronJobs = {};
function startCronJob(dep) {
  if (!dep.cron_schedule || !dep.id) return;
  if (cronJobs[dep.id]) clearInterval(cronJobs[dep.id]);
  const match = dep.cron_schedule.match(/\*\/(\d+)/);
  if (match) {
    const mins = parseInt(match[1]);
    cronJobs[dep.id] = setInterval(async () => {
      await addLog(dep.id, 'Cron triggered redeploy');
    }, mins * 60 * 1000);
  }
}

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

// Get container ENV for a deployment
app.get('/deployments/:id/env', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];
    const savedEnv = dep.env_vars || {};
    res.json({ envVars: savedEnv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Webhook
app.post('/webhook/:id', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];
    if (dep.webhook_secret) {
      const sig = req.headers['x-hub-signature-256'] || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', dep.webhook_secret).update(req.body).digest('hex');
      if (sig !== expected) return res.status(401).json({ error: 'Invalid signature' });
    }
    res.json({ success: true, message: 'Webhook received!' });
    await addLog(dep.id, 'Webhook triggered - redeploying...');
    await runDeploy(dep.id, dep.repo_url, dep.branch, dep.webhook_secret || '', dep.env_vars || {}, dep.dockerfile_path, dep.root_directory, dep.start_command, dep.healthcheck_path, dep.restart_policy, dep.compose_file, true);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update ENV
app.post('/deployments/:id/env', async (req, res) => {
  try {
    const { envVars = {} } = req.body;
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];

    // Merge with saved env
    const savedEnv = dep.env_vars || {};
    const mergedEnv = Object.assign({}, savedEnv, envVars);

    // Save merged ENV to DB
    await pool.query('UPDATE deployments SET env_vars=$1 WHERE id=$2', [JSON.stringify(mergedEnv), dep.id]);

    // Handle compose deployment
    const repoPath = path.join(REPOS_DIR, dep.id);
    const composePath = dep.compose_file
      ? path.join(repoPath, dep.compose_file.replace(/^\//, ''))
      : path.join(repoPath, 'docker-compose.yml');

    if (fs.existsSync(composePath)) {
      const envLines = Object.entries(mergedEnv).map(([k,v]) => k + '=' + v);
      fs.writeFileSync(path.join(repoPath, '.env'), envLines.join('\n'));
      const projectName = 'flash' + dep.id;
      execSync('docker-compose -p ' + projectName + ' -f ' + composePath + ' up -d --force-recreate', {
        cwd: repoPath, stdio: 'pipe', timeout: 120000
      });
      await addLog(dep.id, 'ENV updated and compose services restarted');
      return res.json({ success: true, message: 'ENV updated and restarted!' });
    }

    // Single container
    if (!dep.container_id) return res.status(400).json({ error: 'No container found' });
    const c = docker.getContainer(dep.container_id);
    const info = await c.inspect();
    const existingEnv = info.Config.Env || [];
    const newEnvEntries = Object.entries(mergedEnv).map(([k,v]) => k + '=' + v);
    const filteredExisting = existingEnv.filter(e => !Object.keys(mergedEnv).includes(e.split('=')[0]));
    const finalEnv = [...filteredExisting, ...newEnvEntries];

    await c.stop().catch(() => {});
    await c.remove().catch(() => {});
    const imgName = 'flash-' + dep.id;
    const intPort = getIntPort(dep.project_type);
    const portBindings = {};
    portBindings[intPort + '/tcp'] = [{ HostPort: String(dep.host_port) }];
    const exposedPorts = {};
    exposedPorts[intPort + '/tcp'] = {};
    const container = await docker.createContainer({
      Image: imgName, name: 'flash-' + dep.id, Env: finalEnv,
      ExposedPorts: exposedPorts,
      HostConfig: { PortBindings: portBindings, Memory: 512*1024*1024, NanoCpus: 1000000000, RestartPolicy: getRestartPolicy(dep.restart_policy) }
    });
    await container.start();
    await pool.query('UPDATE deployments SET container_id=$1, status=$2 WHERE id=$3', [container.id, 'live', dep.id]);
    await addLog(dep.id, 'ENV updated and container restarted');
    res.json({ success: true, message: 'ENV updated and restarted!' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update settings
app.post('/deployments/:id/settings', async (req, res) => {
  try {
    const { restartPolicy, healthcheckPath, cronSchedule, webhookSecret } = req.body;
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query(
      'UPDATE deployments SET restart_policy=$1, healthcheck_path=$2, cron_schedule=$3, webhook_secret=$4 WHERE id=$5',
      [restartPolicy || 'unless-stopped', healthcheckPath || '', cronSchedule || '', webhookSecret || '', req.params.id]
    );
    const updated = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (updated.rows.length) startCronJob(updated.rows[0]);
    res.json({ success: true, message: 'Settings updated!' });
    await addLog(req.params.id, 'Settings updated');
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Redeploy endpoint
app.post('/deployments/:id/redeploy', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM deployments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const dep = r.rows[0];
    
    await pool.query('UPDATE deployments SET status=$1, error_msg=$2 WHERE id=$3', ['building', null, dep.id]);
    await addLog(dep.id, 'Redeploying...');
    
    res.json({ success: true, message: 'Redeploy started!' });
    
    (async () => {
      await runDeploy(dep.id, dep.repo_url, dep.branch, dep.webhook_secret || '', dep.env_vars || {}, dep.dockerfile_path, dep.root_directory, dep.start_command, dep.healthcheck_path, dep.restart_policy, dep.compose_file, true);
    })();
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    const repoPath = path.join(REPOS_DIR, dep.id);
    const composePath = dep.compose_file
      ? path.join(repoPath, dep.compose_file.replace(/^\//, ''))
      : path.join(repoPath, 'docker-compose.yml');

    if (fs.existsSync(composePath)) {
      try {
        execSync('docker-compose -p flash' + dep.id + ' -f ' + composePath + ' down', { cwd: repoPath, stdio: 'pipe' });
      } catch(e) {}
    }

    if (dep.container_ids) {
      for (const [svc, cid] of Object.entries(dep.container_ids)) {
        const c = docker.getContainer(cid);
        await c.stop().catch(() => {});
        await c.remove().catch(() => {});
      }
    }

    if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true });
    await pool.query('DELETE FROM deployments WHERE id=$1', [req.params.id]);
    if (cronJobs[req.params.id]) { clearInterval(cronJobs[req.params.id]); delete cronJobs[req.params.id]; }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runDeploy(id, repoUrl, branch, token, envVars, dockerfilePath, rootDirectory, startCommand, healthcheckPath, restartPolicy, composeFile, isRedeploy) {
  const repoPath = path.join(REPOS_DIR, id);
  const imgName = 'flash-' + id;

  try {
    const r = await pool.query('SELECT host_port FROM deployments WHERE id=$1', [id]);
    const hostPort = r.rows[0].host_port;

    if (!isRedeploy || !fs.existsSync(repoPath)) {
      const cloneUrl = buildCloneUrl(repoUrl, token);
      await addLog(id, 'Cloning ' + repoUrl + ' (branch: ' + branch + ')');
      await simpleGit({ binary: '/usr/bin/git' }).clone(cloneUrl, repoPath, ['--branch', branch, '--depth', '1']);
      await addLog(id, 'Clone successful');
    } else {
      const cloneUrl = buildCloneUrl(repoUrl, token);
      if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true });
      await simpleGit({ binary: '/usr/bin/git' }).clone(cloneUrl, repoPath, ['--branch', branch, '--depth', '1']);
      await addLog(id, 'Re-cloned for redeploy');
    }

    // Check for docker-compose (only if no dockerfile specified)
    const composePath = !dockerfilePath && hasComposeFile(repoPath, composeFile);
    if (composePath) {
      const { services, containerIds, mainUrl } = await deployWithCompose(id, repoPath, composePath, envVars || {}, restartPolicy);
      await pool.query(
        'UPDATE deployments SET status=$1, container_ids=$2, services=$3, access_url=$4, project_type=$5, env_vars=$6 WHERE id=$7',
        ['live', JSON.stringify(containerIds), JSON.stringify(services), mainUrl || '', 'compose', JSON.stringify(envVars || {}), id]
      );
      await addLog(id, 'LIVE at ' + (mainUrl || '(check docker-compose ports config)'));
      return;
    }

    // Single container
    const buildPath = rootDirectory ? path.join(repoPath, rootDirectory.replace(/^\//, '')) : repoPath;
    if (!fs.existsSync(buildPath)) throw new Error('Root directory not found: ' + rootDirectory);

    const type = detectType(buildPath);
    await addLog(id, 'Project type: ' + type);

    let dfFlag = '';
    if (dockerfilePath) {
      const customDf = path.join(repoPath, dockerfilePath.replace(/^\//, ''));
      if (fs.existsSync(customDf)) {
        fs.copyFileSync(customDf, path.join(buildPath, 'Dockerfile.custom'));
        dfFlag = '-f Dockerfile.custom';
        await addLog(id, 'Using custom Dockerfile: ' + dockerfilePath);
      } else {
        throw new Error('Dockerfile not found: ' + dockerfilePath);
      }
    } else if (type !== 'docker') {
      generateDockerfile(type, buildPath, startCommand);
      dfFlag = '-f Dockerfile.flash';
    }

    await addLog(id, 'Building Docker image...');
    execSync('docker build ' + dfFlag + ' -t ' + imgName + ' .', { cwd: buildPath, stdio: 'pipe', timeout: 300000 });
    await addLog(id, 'Docker image built successfully');

    if (isRedeploy) {
      const old = await pool.query('SELECT container_id FROM deployments WHERE id=$1', [id]);
      if (old.rows[0] && old.rows[0].container_id) {
        const c = docker.getContainer(old.rows[0].container_id);
        await c.stop().catch(() => {});
        await c.remove().catch(() => {});
      }
    }

    const intPort = getIntPort(type);
    const portBindings = {};
    portBindings[intPort + '/tcp'] = [{ HostPort: String(hostPort) }];
    const exposedPorts = {};
    exposedPorts[intPort + '/tcp'] = {};
    const envArray = ['PORT=' + intPort, ...Object.entries(envVars || {}).map(([k,v]) => k + '=' + v)];

    const container = await docker.createContainer({
      Image: imgName, name: 'flash-' + id, Env: envArray,
      ExposedPorts: exposedPorts,
      HostConfig: { PortBindings: portBindings, Memory: 512*1024*1024, NanoCpus: 1000000000, RestartPolicy: getRestartPolicy(restartPolicy || 'unless-stopped') }
    });
    await container.start();
    await addLog(id, 'Container started on port ' + hostPort);

    const serverIP = process.env.SERVER_IP || '34.201.132.220';
    const accessUrl = buildAccessUrl(serverIP, hostPort);

    if (healthcheckPath) {
      await addLog(id, 'Running healthcheck...');
      let healthy = false;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try { execSync('curl -sf ' + accessUrl + healthcheckPath, { timeout: 5000 }); healthy = true; break; } catch(e) {}
      }
      await addLog(id, healthy ? 'Healthcheck passed!' : 'WARNING: Healthcheck failed');
    }

    await pool.query(
      'UPDATE deployments SET status=$1, container_id=$2, project_type=$3, access_url=$4, env_vars=$5 WHERE id=$6',
      ['live', container.id, type, accessUrl, JSON.stringify(envVars || {}), id]
    );
    await addLog(id, 'LIVE at ' + accessUrl);

  } catch (err) {
    await pool.query('UPDATE deployments SET status=$1, error_msg=$2 WHERE id=$3', ['failed', err.message, id]);
    console.error('[FAIL]', id, err.message);
  }
}

app.post('/deploy', async (req, res) => {
  const {
    repoUrl, branch = 'main', expiry = '30days', token = '', envVars = {},
    dockerfilePath = '', rootDirectory = '', startCommand = '',
    healthcheckPath = '', restartPolicy = 'unless-stopped',
    webhookSecret = '', cronSchedule = '', composeFile = ''
  } = req.body;

  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const id = uuidv4().split('-')[0];
  const hostPort = randomPort();
  const expiryMs = EXPIRY_MS[expiry] || EXPIRY_MS['30days'];
  const now = Date.now();

  await pool.query(
    `INSERT INTO deployments
     (id, repo_url, branch, status, host_port, expiry, logs, created_at, expires_at,
      dockerfile_path, root_directory, start_command, healthcheck_path, restart_policy,
      webhook_secret, cron_schedule, compose_file, env_vars)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, repoUrl, branch, 'building', hostPort, expiry, [], now, now + expiryMs,
     dockerfilePath, rootDirectory, startCommand, healthcheckPath, restartPolicy,
     webhookSecret, cronSchedule, composeFile, JSON.stringify(envVars)]
  );

  res.json({ id, status: 'building', message: 'Deployment started!', webhookUrl: '/webhook/' + id });

  if (cronSchedule) startCronJob({ id, cron_schedule: cronSchedule });

  (async () => {
    await runDeploy(id, repoUrl, branch, token, envVars, dockerfilePath, rootDirectory, startCommand, healthcheckPath, restartPolicy, composeFile, false);
  })();
});

const PORT = parseInt(process.env.PORT) || 5000;
initDB()
  .then(() => app.listen(PORT, () => console.log('[OK] FlashDeploy backend on port ' + PORT)))
  .catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
