#!/usr/bin/env bash
# One-time setup: creates the Azure AD app registration that GitHub Actions
# uses to deploy this app via OIDC (no stored client secret). Run this once,
# by someone with Application Administrator / Global Administrator rights in
# the "Pay-As-You-Go" tenant — app registration and role assignment are both
# privileged operations that a normal contributor account cannot perform.
#
# Prerequisite: `az login` as that admin account first.
#
# What it creates, all scoped to this one repo/branch and least-privilege:
#   - App registration + service principal: ai-pipeline-generator-github-deploy
#   - Federated credential trusting GitHub OIDC tokens from
#     ExperionCloudops/ai-standalone-tool on the main branch only
#   - AcrPush on the container registry (push images, nothing else)
#   - Contributor on just the ai-pipeline-generator Container App resource
#     (not the whole resource group)
set -euo pipefail

APP_NAME="ai-pipeline-generator-github-deploy"
REPO="ExperionCloudops/ai-standalone-tool"
BRANCH="main"
SUBSCRIPTION_ID="09fd34f3-62c0-41a6-aa81-dbf429305626"
RESOURCE_GROUP="rg-ai-devops-tool"
REGISTRY_NAME="experionaitoolacr"
CONTAINER_APP_NAME="ai-pipeline-generator"

echo "Creating app registration: $APP_NAME"
APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
echo "  appId = $APP_ID"

echo "Creating service principal for it"
az ad sp create --id "$APP_ID" >/dev/null

echo "Adding federated credential for $REPO (branch: $BRANCH)"
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-$BRANCH\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:$REPO:ref:refs/heads/$BRANCH\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

echo "Granting AcrPush on registry: $REGISTRY_NAME"
az role assignment create \
  --assignee "$APP_ID" \
  --role AcrPush \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.ContainerRegistry/registries/$REGISTRY_NAME"

echo "Granting Contributor on Container App: $CONTAINER_APP_NAME"
az role assignment create \
  --assignee "$APP_ID" \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps/$CONTAINER_APP_NAME"

TENANT_ID=$(az account show --query tenantId -o tsv)

echo ""
echo "Done. Add these as GitHub Actions repository secrets"
echo "(repo Settings > Secrets and variables > Actions > New repository secret) on $REPO:"
echo ""
echo "  AZURE_CLIENT_ID       = $APP_ID"
echo "  AZURE_TENANT_ID       = $TENANT_ID"
echo "  AZURE_SUBSCRIPTION_ID = $SUBSCRIPTION_ID"
echo ""
echo "Once set, .github/workflows/deploy.yml will build, push to ACR, and"
echo "deploy to the Container App on every push to $BRANCH."
