# AI Pipeline & Environment Generator — standalone

A small, self-hosted, **generic** pipeline & environment generator. It runs
as one Docker container: a static frontend plus a lightweight Node/Express
backend that calls the Anthropic API directly. No claude.ai dependency, no
repo access to any target project needed, and no hardcoded client/project
list — every generation is parameterized by the cloud provider, IaC tool,
and pipeline tool you pick at the top of the page:

- **Cloud provider**: AWS, Azure, GCP, or Other/multi-cloud
- **IaC tool**: Terraform, Bicep, CloudFormation, ARM Templates, Pulumi,
  AWS CDK, OpenTofu, Ansible
- **Pipeline tool**: GitHub Actions, Azure DevOps, Jenkins, GitLab CI/CD,
  Harness, CircleCI, Bitbucket Pipelines, AWS CodePipeline

These selectors apply across all three modes below (switching modes doesn't
reset them):

- **Generate from scratch** — describe an environment/pipeline in plain English,
  get back a proper multi-file layout (not one giant flat snippet): reusable
  IaC modules under `modules/` with thin per-environment entrypoints under
  `environments/<env>/`, and the pipeline file in that tool's idiomatic
  location (`.github/workflows/`, `azure-pipelines.yml` + `templates/`,
  `Jenkinsfile` + shared `vars/`, `.gitlab-ci.yml` + `include:` files, etc.) —
  the folder structure a platform team would actually adopt, shown as a file
  manifest plus a tabbed viewer.
- **Review & improve existing code** — paste an existing (redacted) pipeline
  or IaC snippet, or upload it: a `.zip` of the repo/folder, or individual
  IaC/pipeline files (Terraform, Bicep, CloudFormation, ARM, Dockerfile,
  Azure Pipelines, GitHub Actions, Jenkinsfile, GitLab CI, etc.), and get
  back the issues found plus an improved version *restructured into that
  same best-practice folder layout*, even if the original was one flat file.
  A zip is unzipped entirely in the browser (JSZip) and each file is
  auto-sorted into the IaC field or the pipeline field by filename/content;
  `.tfstate`, `.pem`/`.key`, `.env`, and similar secret/state files are
  filtered out automatically, and build/vendor directories (`node_modules`,
  `.git`, `dist`, etc.) are skipped. Review the populated fields before
  generating — nothing is sent to the backend until you click Generate.
- **Full solution bundle** — describe an end-to-end need (e.g. "onboard a new
  client across dev/qa/staging/prod") and get back a *complete* file set:
  environment-separated IaC, a full multi-stage pipeline with security gates,
  and a README explaining how to adopt it.

All three modes share one results panel (impact summary, explanation, issues
found, file manifest, and a tabbed code/file viewer in a single card instead
of scattered boxes), a **Stop generating** button that cancels the in-flight
request — and the upstream call to Anthropic is aborted server-side too, so
clicking Stop doesn't just hide the wait, it actually stops burning tokens —
and a **Download** control that bundles whatever was generated as a `.zip`
or `.tar`, your choice.

There's also a disabled "Push to Git" button next to the download button.
It's intentionally not wired up yet — it needs real repo credentials
(a PAT or GitHub App / Azure DevOps service connection) per target repo,
which don't exist under the current access model. `/api/push-to-git` on the
backend returns a clear 501 explaining why, and is where that integration
plugs in later without touching the generation logic — it would reuse the
same `files` array `/api/generate-solution` already produces, just commit
it to a new branch and open a PR instead of zipping it.

## Before you paste anything in

Redact account IDs, subscription IDs, hostnames, internal IPs, and —
critically — never paste real secret values or credentials, even when the
whole point is to fix secrets being in the repo. Use obvious placeholders
(`ACCOUNT_ID`, `<SUBSCRIPTION_ID>`, `REDACTED`) instead.

## 1. Get an Anthropic API key

Create one at https://console.anthropic.com (Settings → API Keys). This is
separate from any claude.ai seat — it's billed per API call. Costs for this
tool are small (a few cents per generation) but are real once deployed.

## 2. Run it locally first

```bash
cp .env.example .env
# edit .env: paste in your ANTHROPIC_API_KEY and choose AUTH_USERNAME / AUTH_PASSWORD (the login for the tool)
docker compose up --build
```

Open http://localhost:8080 and confirm both modes work before deploying
anywhere. `GET /api/health` should return `{"status":"ok","configured":true}`.

## 3. Deploy — same image, either cloud

This project's own instance already runs on Azure Container Apps
(`ai-pipeline-generator` in resource group `rg-ai-devops-tool`, registry
`experionaitoolacr.azurecr.io`), deployed automatically by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push
to `main` — it builds the image, pushes it to ACR, then runs
`az containerapp update` to roll it out. That workflow authenticates to
Azure via OIDC (no stored secret); an Azure AD admin provisions the
federated identity once with
[`scripts/setup-azure-oidc.sh`](scripts/setup-azure-oidc.sh), which prints
the three repo secrets (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`) to add under repo Settings → Secrets and variables
→ Actions.

For a new environment/registry, or a manual one-off deploy, build once and
push to whichever registry the target cloud uses:

```bash
docker build -t ai-pipeline-generator:latest .
```

### Option A — AWS (ECS Fargate, or App Runner for less setup)

1. Push the image to Amazon ECR:
   ```bash
   aws ecr create-repository --repository-name ai-pipeline-generator
   aws ecr get-login-password | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
   docker tag ai-pipeline-generator:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/ai-pipeline-generator:latest
   docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/ai-pipeline-generator:latest
   ```
2. Store `AUTH_USERNAME`, `AUTH_PASSWORD` and `ANTHROPIC_API_KEY` in AWS Secrets Manager, not as a plain environment
   variable, and reference the secret from the task definition.
3. Simplest path: **App Runner** — point it at the ECR image, map the secret,
   expose port 8080. No VPC/ALB setup needed for a quick internal pilot.
   More control: **ECS Fargate** behind an internal ALB if it needs to sit
   inside a private VPC the project team already trusts.

### Option B — Azure (Container Apps, or App Service for Containers)

1. Push the image to Azure Container Registry:
   ```bash
   az acr create --name <REGISTRY_NAME> --resource-group <RG> --sku Basic
   az acr login --name <REGISTRY_NAME>
   docker tag ai-pipeline-generator:latest <REGISTRY_NAME>.azurecr.io/ai-pipeline-generator:latest
   docker push <REGISTRY_NAME>.azurecr.io/ai-pipeline-generator:latest
   ```
2. Store `ANTHROPIC_API_KEY` in Azure Key Vault and reference it as a secret
   in the container app / app service configuration — not a plain app setting.
   For sign-in, turn on the Container App's built-in authentication (Microsoft Entra ID, **Require
   authentication**), set `AUTH_MODE=entra` and `ADMIN_EMAILS=<comma-separated admin emails>`, and in Entra
   (Enterprise applications → Properties) set **Assignment required = Yes** and assign your users/group.
   Users who aren't admins can generate but not use admin-only actions.
3. Simplest path: **Azure Container Apps** — `az containerapp create` pointing
   at the ACR image, with the Key Vault secret mounted as an env var, port 8080.

Either way, the only cloud-specific work is the secret store and the
container host — the image itself is identical, which is the point: it can
run in Experion's own cloud ops account for internal testing, or be hosted
inside the client's subscription/account if they'd rather it stay on their
side, without any code changes.

## 4. What it needs from a project team to try "review & improve"

Nothing ongoing. One-time ask per project:
- One existing pipeline file, redacted
- One existing IaC file if any exists, redacted (or a `.zip` of the repo/folder)
- A sentence or two on what's slow or painful about it today

That's enough to run the "review & improve" mode and show a credible
before/after without needing repo access, CI integration, or their time
beyond sending a couple of files.

## Notes on cost and safety

- The API key lives only in the backend's environment/secret store — the
  browser never sees it.
- Every request is logged server-side only for error diagnostics (see
  `console.error` calls in `server/index.js`); nothing is persisted to disk
  or a database in this minimal version.
- If you want to keep a history of generations, add a small database (or
  even a JSON file for a pilot) — not included here to keep the first
  deployment as simple as possible.
