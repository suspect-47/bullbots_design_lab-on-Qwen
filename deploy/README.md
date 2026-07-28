# Deploying BullBots Design Lab on Alibaba Cloud

Two supported paths for the Fastify backend:

| Path | Best for | Files |
|---|---|---|
| **A — Function Compute 3.0** (custom container) | Judged demo, scale-to-zero, public HTTPS URL in one command | `deploy/Dockerfile`, `deploy/s.yaml` |
| **B — ECS + systemd + nginx** | A long-lived box you can SSH into | `deploy/ecs-setup.sh` |

The frontend is a static Vite bundle and deploys to **Alibaba Cloud OSS static
website hosting** in both cases (the API does not serve `dist/`).

---

## Alibaba Cloud API proof

The backend calls **Alibaba Cloud Model Studio (DashScope)** directly:

- **`server/llm/qwen.js`** — OpenAI-compatible client that POSTs to
  `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
  with the `DASHSCOPE_API_KEY` bearer token and the `QWEN_MODEL` model id.

Consumed by the `/chat`, `/design` and `/verdict` routes in `server/api/app.js`.
Other Alibaba Cloud services used: **Function Compute 3.0** (`deploy/s.yaml`),
**Container Registry / ACR** (image host), **OSS** (frontend hosting),
optionally **ApsaraDB RDS for PostgreSQL** (`DATABASE_URL`).

---

## 0. Prerequisites (once)

1. Create an Alibaba Cloud account and complete real-name verification.
2. **RAM user + AccessKey**: RAM console → Users → Create User → *OpenAPI access*.
   Attach `AliyunFCFullAccess`, `AliyunContainerRegistryFullAccess`,
   `AliyunOSSFullAccess`. Save the AccessKey ID/Secret.
3. **Model Studio API key**: <https://bailian.console.alibabacloud.com/> →
   API-KEY → Create. This is `DASHSCOPE_API_KEY` (`sk-...`).
4. Install tooling:

```bash
npm i -g @serverless-devs/s3          # the `s` CLI
brew install aliyun-cli ossutil       # or: curl the Linux binaries
docker --version                      # Docker 20.10+ with buildx
```

5. Register the credential alias used by `deploy/s.yaml`:

```bash
s config add --AccessKeyID <AK> --AccessKeySecret <SK> -a default
aliyun configure set --profile default \
  --mode AK --access-key-id <AK> --access-key-secret <SK> \
  --region ap-southeast-1
```

6. Export the runtime secrets that `s.yaml` reads via `${env(...)}`:

```bash
export DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxx
export DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
export QWEN_MODEL=qwen-plus
export DATABASE_URL=            # optional; empty is fine, API boots without it
export ACR_NAMESPACE=bullbots # your ACR namespace
```

---

## Path A — Function Compute 3.0

### A1. Create the ACR repository

Container Registry console (region **Singapore / ap-southeast-1**) → Personal
or Enterprise instance → Namespace `bullbots` → Repository `bullbots-api`
(type: *Local repository*).

### A2. Build and push the image

Function Compute runs **linux/amd64**. On an Apple Silicon Mac you must cross-build.

```bash
cd /path/to/bullbots

export ACR_REGISTRY=registry-intl.ap-southeast-1.aliyuncs.com
export ACR_NAMESPACE=bullbots
export IMAGE=$ACR_REGISTRY/$ACR_NAMESPACE/bullbots-api:latest

# Log in (username = your Alibaba Cloud account, password = the ACR
# "Access Credential" you set in the console, NOT the console password).
docker login --username=<your@account> $ACR_REGISTRY

docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile -t $IMAGE --push .

# Non-buildx equivalent:
# docker build --platform linux/amd64 -f deploy/Dockerfile -t $IMAGE .
# docker push $IMAGE
```

Sanity-check the image locally before pushing:

```bash
docker run --rm -p 9000:9000 -e PORT=9000 -e DASHSCOPE_API_KEY=$DASHSCOPE_API_KEY $IMAGE
curl localhost:9000/health
```

### A3. Deploy

```bash
cd deploy
s deploy -y
```

`s.yaml` creates function `bullbots-api` in `ap-southeast-1`:
`custom-container` runtime, port 9000, 1024 MB, 60 s timeout, `/health` probe,
and an HTTP trigger with **anonymous** auth.

### A4. Get the public URL

`s deploy` prints it. To fetch it again:

```bash
s info                                  # look for url.system_url / custom_domain
# or:
aliyun fc GET /2023-03-30/functions/bullbots-api/triggers/httpTrigger \
  --region ap-southeast-1
```

It looks like:

```
https://bullbots-api-<uid>-<hash>.ap-southeast-1.fcapp.run
```

Verify:

```bash
export API_URL=https://bullbots-api-xxxx.ap-southeast-1.fcapp.run
curl $API_URL/health
curl $API_URL/meta
curl -X POST $API_URL/chat -H 'content-type: application/json' \
  -d '{"message":"how do I beat a vertical spinner?"}'
```

### A5. Day-2 operations

```bash
s logs -t                 # tail function logs (SLS)
s deploy -y               # redeploy after `docker push` of a new :latest
s remove -y               # tear down
```

Rotating a secret only (no image rebuild):

```bash
export DASHSCOPE_API_KEY=sk-new... && s deploy -y
```

---

## Path B — ECS + systemd + nginx

### B1. Create the instance

ECS console → Create Instance → region **ap-southeast-1**, `ecs.t6-c1m2.large`
or larger, image **Ubuntu 22.04 64-bit**, assign a public IPv4 (or bind an EIP).
Security group inbound: **22/tcp** (your IP) and **80/tcp** (0.0.0.0/0).

### B2. Provision

```bash
ssh root@<ECS_PUBLIC_IP>

curl -fsSL https://raw.githubusercontent.com/suspect-47/bullbots-design-lab/main/deploy/ecs-setup.sh -o ecs-setup.sh

sudo DASHSCOPE_API_KEY=sk-xxxx \
     QWEN_MODEL=qwen-plus \
     DATABASE_URL= \
     bash ecs-setup.sh
```

The script installs Node 20, clones the repo to `/opt/bullbots`, runs
`npm ci --omit=dev`, writes `/etc/bullbots-api.env` (0640) and the
`bullbots-api.service` unit, enables + starts it, and configures nginx to
reverse-proxy `:80 → 127.0.0.1:3001`. It is idempotent — re-run to update.

### B3. Verify and operate

```bash
curl http://<ECS_PUBLIC_IP>/health
systemctl status bullbots-api
journalctl -u bullbots-api -f
sudo bash ecs-setup.sh        # pull latest code + restart
```

`API_URL` for the frontend is then `http://<ECS_PUBLIC_IP>`.
For HTTPS, point a domain at the IP and run `certbot --nginx`.

---

## Frontend → Alibaba Cloud OSS static website hosting

The API has no static-file plugin; the SPA is hosted on OSS.

### F1. Build against the deployed API

```bash
cd /path/to/bullbots
export VITE_API_BASE=https://bullbots-api-xxxx.ap-southeast-1.fcapp.run   # Path A
# export VITE_API_BASE=http://<ECS_PUBLIC_IP>                               # Path B

VITE_API_BASE=$VITE_API_BASE npm run build     # -> dist/
```

`VITE_API_BASE` is baked in at build time — rebuild whenever the backend URL
changes. Add it to `.env` locally, or `.env.production` in CI.

### F2. Create the bucket

OSS console → Create Bucket, region **Singapore (ap-southeast-1)**, ACL
**Public Read**, then Bucket → Static Pages: Default Homepage `index.html`,
Default 404 Page `index.html` (SPA routing).

### F3. Upload

```bash
ossutil config -e oss-ap-southeast-1.aliyuncs.com -i <AK> -k <SK>

ossutil cp -r dist/ oss://<bucket>/ --update
# Long-cache hashed assets, never cache the entry HTML:
ossutil set-meta oss://<bucket>/assets/ Cache-Control:"public,max-age=31536000,immutable" -r -f
ossutil set-meta oss://<bucket>/index.html Cache-Control:"no-cache" -f
```

Site URL: `https://<bucket>.oss-ap-southeast-1.aliyuncs.com/index.html`
(front it with Alibaba Cloud CDN for a custom domain + HTTPS).

### F4. CORS

The browser calls the API cross-origin. Path B already sends permissive CORS
headers from nginx. For Path A, allow the OSS origin in the FC HTTP trigger's
CORS settings (or in `server/api/app.js`) — tighten `*` to the bucket domain
before anything but a demo.

---

## Environment variable reference

| Variable | Where | Purpose |
|---|---|---|
| `DASHSCOPE_API_KEY` | backend | Model Studio key used by `server/llm/qwen.js` |
| `DASHSCOPE_BASE_URL` | backend | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL` | backend | e.g. `qwen-plus`, `qwen-max`, `qwen-turbo` |
| `DATABASE_URL` | backend | ApsaraDB RDS for PostgreSQL DSN; optional — `/bots` and `/meta` are the only DB routes and the API boots without it |
| `PORT` | backend | `9000` on Function Compute, `3001` on ECS |
| `ACR_NAMESPACE` | deploy | ACR namespace interpolated into `s.yaml`'s image path |
| `ALIYUN_ACCESS` | deploy | Serverless Devs credential alias (default `default`) |
| `VITE_API_BASE` | frontend build | Public backend URL baked into `dist/` |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `exec format error` in FC logs | Image built for arm64. Rebuild with `--platform linux/amd64`. |
| FC function never becomes healthy | Container must listen on `0.0.0.0:9000`. Confirm `PORT=9000` is in `environmentVariables` and `/health` returns 200. |
| `denied: requested access to the resource is denied` on push | `docker login` used the console password. Use the ACR *Access Credential* password, and confirm the namespace exists. |
| 403 from DashScope | Key is from the China-site console but `DASHSCOPE_BASE_URL` is the international endpoint (or vice versa). Match them. |
| Browser CORS error | See F4. |
| Frontend still hits `localhost:3001` | `VITE_API_BASE` was unset at build time; rebuild and re-upload `dist/`. |
