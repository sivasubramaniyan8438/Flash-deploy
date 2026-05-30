# FlashDeploy

Railway-style temporary deployment platform. Deploy any GitHub repo with one click.

## Requirements

- Linux server (Ubuntu/Amazon Linux)
- Docker + Docker Compose
- Port 80, 5000, 5100-9000 open in firewall

## Setup

### 1. Install Docker (if not already installed)

```bash
# Amazon Linux
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER

# Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 2. Clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/flashdeploy.git
cd flashdeploy
```

### 3. Configure your server IP

Edit `docker-compose.yml` and replace `YOUR_SERVER_IP` with your actual server IP:

```yaml
SERVER_IP: "54.xxx.xxx.xxx"
```

### 4. Configure GitHub token (for private repos)

```bash
git config --global url."https://YOUR_GITHUB_TOKEN@github.com/".insteadOf "https://github.com/"
```

### 5. Start

```bash
docker-compose up --build -d
```

### 6. Open browser

```
http://YOUR_SERVER_IP
```

## Usage

1. Paste GitHub repo URL
2. Select branch (main/master/dev)
3. Select expiry (7/30/90 days)
4. Click Deploy
5. Wait for build to complete
6. Click the URL to open your deployed app

## Supported Project Types

| Type | Detection | Port |
|------|-----------|------|
| Node.js | package.json (no React) | 3000 |
| React/Next.js | package.json (react/next/vite) | 80 |
| Python | requirements.txt | 8000 |
| Static HTML | index.html | 80 |
| Custom | Dockerfile present | as defined |

## Commands

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# View logs
docker-compose logs -f

# Rebuild
docker-compose up --build -d

# Update
git pull && docker-compose up --build -d
```
