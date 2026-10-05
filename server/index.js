// server/index.js
//
// Minimal standalone backend for the AI Pipeline & Environment Generator.
// Runs identically on AWS (ECS Fargate / App Runner) or Azure (Container Apps /
// App Service for Containers) — it's a plain Node/Express container with no
// cloud-specific SDK calls. The only cloud-specific piece is wherever you put
// the ANTHROPIC_API_KEY secret (Secrets Manager on AWS, Key Vault on Azure).

const express = require("express");
const path = require("path");

const app = express();
// Bumped from 1mb: "Review & improve existing code" now accepts a zip/folder
// upload (unzipped client-side and concatenated into existingIac/existingPipeline),
// which can be larger than a single pasted snippet.
app.use(express.json({ limit: "6mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

if (!API_KEY) {
  console.warn(
    "WARNING: ANTHROPIC_API_KEY is not set. /api/generate will fail until it is configured."
  );
}

// Cloud/IaC/pipeline-tool selection is optional — the UI lets these be left
// unset so the model can infer the best fit from the request or existing
// code instead of being forced into a specific stack.
function normalizeStackFields(body) {
  return {
    cloud: (body.cloud || "").trim(),
    iacTool: (body.iacTool || "").trim(),
    pipelineTool: (body.pipelineTool || "").trim(),
  };
}

function describeStackChoice(label, value) {
  return value
    ? `${label}: ${value}.`
    : `${label}: not specified — infer the most sensible choice from the request/existing code and state that assumption in the explanation.`;
}

function buildPrompt({ cloud, iacTool, pipelineTool, userReq, existingIac, existingPipeline }) {
  const hasExisting = Boolean((existingIac && existingIac.trim()) || (existingPipeline && existingPipeline.trim()));

  const header = `You are an AI DevOps engineer helping design and improve cloud infrastructure and CI/CD pipelines. ${describeStackChoice("Target cloud", cloud)} ${describeStackChoice("Infrastructure-as-code tool", iacTool)} ${describeStackChoice("Pipeline tool", pipelineTool)}`;

  const requestBlock = `Request:\n"""\n${userReq || "(no specific request given — assess and improve the existing code below)"}\n"""`;

  const existingBlock = hasExisting
    ? `\nExisting code provided by the team (redacted of any real identifiers/secrets — treat placeholders like ACCOUNT_ID, <SUBSCRIPTION>, etc. as intentional):\n\n--- EXISTING IAC ---\n${existingIac || "(none provided)"}\n\n--- EXISTING PIPELINE ---\n${existingPipeline || "(none provided)"}\n`
    : "";

  const stackLabel = [iacTool, pipelineTool].filter(Boolean).join(" + ") || "whichever IaC and pipeline tool you infer fits best";
  const folderGuidance = `Lay the output out in the folder structure a competent platform team would actually adopt for ${stackLabel} — do not return one flat snippet. As a guide (adapt to what actually fits the tooling, this is not a rigid template):
- IaC: reusable building blocks under modules/ (or the tool's equivalent), with a thin per-environment entrypoint under environments/<env>/ (or per-environment .tfvars/.bicepparam/parameter files) that calls those modules — not one giant file repeating itself per environment.
- Pipeline: the pipeline tool's idiomatic file location (e.g. .github/workflows/*.yml for GitHub Actions, azure-pipelines.yml at the repo root plus templates/ for reusable stages on Azure DevOps, Jenkinsfile at the root plus a shared vars/ library for Jenkins, .gitlab-ci.yml plus include: files for GitLab CI/CD).
Even if the existing code was a single flat file, restructure it into this layout as part of the improvement.`;

  const taskWithExisting = hasExisting
    ? `Produce:
1. A 2-3 sentence plain-English explanation for a non-technical audience of what's wrong with the existing code and what you changed.
2. A list "existing_code_issues": 3-6 short, specific issues found in the existing code (maturity gaps: hardcoded values, no environment separation, missing security scanning, no remote state, etc.)
3. An improved, restructured set of files that fixes those issues while preserving the original intent (use placeholders for anything account/environment-specific; keep each file focused, not exhaustive boilerplate). ${folderGuidance}
4. Within that pipeline file set, add a security scanning gate (Checkov/tfsec for IaC, Trivy for containers, gitleaks for secrets — whichever are relevant) and environment promotion stages if missing.
5. "manual_effort_today": a realistic, conservative one-line estimate of how long a DevOps engineer would take to make these improvements by hand.
6. "with_ai_estimate": a realistic one-line estimate of how long it takes with this generation approach plus human review.`
    : `Produce:
1. A 2-3 sentence plain-English explanation of what you generated and why, for a non-technical audience.
2. A realistic set of files implementing the request (placeholders for account/environment-specific values; brief comments; each file focused, not exhaustive boilerplate). ${folderGuidance}
3. Within that pipeline file set, include a security scanning gate and environment promotion stages if relevant.
4. "manual_effort_today": a realistic, conservative one-line estimate of how long a DevOps engineer would take to hand-write and test this.
5. "with_ai_estimate": a realistic one-line estimate of how long it takes with this generation approach plus human review.`;

  const schema = hasExisting
    ? `{
  "explanation": "string",
  "existing_code_issues": ["string"],
  "manifest": [{"path": "string - file path reflecting the folder structure described above", "purpose": "string - one line on what this file does"}],
  "files": [{"path": "string - same paths as manifest", "content": "string (the improved code, no markdown fences inside)"}],
  "manual_effort_today": "string",
  "with_ai_estimate": "string"
}`
    : `{
  "explanation": "string",
  "manifest": [{"path": "string - file path reflecting the folder structure described above", "purpose": "string - one line on what this file does"}],
  "files": [{"path": "string - same paths as manifest", "content": "string (the raw code, no markdown fences inside)"}],
  "manual_effort_today": "string",
  "with_ai_estimate": "string"
}`;

  return `${header}\n\n${requestBlock}\n${existingBlock}\n${taskWithExisting}\n\nRespond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:\n${schema}`;
}

function extractErrorDetail(errText) {
  try {
    const parsed = JSON.parse(errText);
    return (parsed.error && parsed.error.message) || errText;
  } catch (e) {
    return errText;
  }
}

// Streams the response instead of waiting for one large buffered reply —
// a full solution bundle (many files + README) can take minutes and enough
// output tokens to risk the plain fetch() call itself timing out. `signal`
// is forwarded from the originating Express request so that a client
// disconnect (e.g. the UI's Stop button aborting its fetch) also aborts
// this upstream call instead of burning tokens on an abandoned generation.
async function callAnthropicStreaming({ maxTokens, prompt, signal }) {
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream: true,
      // Extended/adaptive thinking tokens count against max_tokens and were
      // starving the JSON output, causing "cut off" truncations.
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    const err = new Error(errText);
    err.status = upstream.status;
    throw err;
  }

  let text = "";
  let stopReason = null;
  const decoder = new TextDecoder();
  let buffer = "";

  const t0 = Date.now();
  const progress = setInterval(() => console.log(`[gen] ${Math.round((Date.now() - t0) / 1000)}s, ${text.length} chars received`), 15000);
  try {
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr) continue;
      let evt;
      try {
        evt = JSON.parse(jsonStr);
      } catch (e) {
        continue;
      }
      if (evt.type === "message_delta" && evt.usage) console.log("[gen] usage:", JSON.stringify(evt.usage));
      if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
        text += evt.delta.text;
      } else if (evt.type === "message_delta" && evt.delta && evt.delta.stop_reason) {
        stopReason = evt.delta.stop_reason;
      }
    }
  }

  } finally { clearInterval(progress); }
  console.log(`[gen] done in ${Math.round((Date.now() - t0) / 1000)}s, ${text.length} chars, stop=${stopReason}`);
  return { text, stopReason };
}

// The model is asked to embed whole code/YAML files as JSON string values.
// On large outputs it sometimes forgets to escape a literal newline/tab
// inside one of those strings, which is invalid JSON even though the
// overall structure is otherwise well-formed. Walk the text tracking
// whether we're inside a string literal and escape any raw control
// character found there.
function escapeStrayControlChars(str) {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      result += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    result += ch;
  }
  return result;
}

function parseModelJson(raw) {
  // Try the raw text as-is first.
  try {
    return JSON.parse(raw.trim());
  } catch (e) {
    // fall through
  }
  // Strip any ```json / ``` fences anywhere in the text, not just at the
  // very start/end, since the model sometimes adds a sentence before them.
  const withoutFences = raw.replace(/```(?:json)?/gi, "");
  try {
    return JSON.parse(withoutFences.trim());
  } catch (e) {
    // fall through
  }
  // Repair stray unescaped control characters inside string literals.
  try {
    return JSON.parse(escapeStrayControlChars(withoutFences.trim()));
  } catch (e) {
    // fall through
  }
  // Last resort: grab everything between the first { and the last } and
  // try that — handles a leading/trailing sentence around the JSON.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (e) {
      return JSON.parse(escapeStrayControlChars(slice)); // let this throw if it still fails
    }
  }
  throw new Error("No JSON object found in model output");
}

// Long generations produce no response bytes until the model finishes, and
// proxies such as Azure Container Apps ingress cut idle responses (~4 min) with
// a plain-text "stream timeout". Commit to a 200 JSON response up front and
// send whitespace (valid before a JSON value) as keepalive. Because the status
// is already sent, res.json() is overridden to deliver the body as-is; error
// bodies carry an "error" field, which the client checks.
function startKeepalive(res) {
  res.status(200).type("application/json");
  res.flushHeaders();
  const timer = setInterval(() => res.write(" "), 15000);
  const stop = () => clearInterval(timer);
  res.on("close", stop);
  res.json = (obj) => { stop(); res.end(JSON.stringify(obj)); return res; };
}

app.post("/api/generate", async (req, res) => {
  res.on("error", () => {}); // swallow write errors on an already-closed (aborted) connection
  const upstreamController = new AbortController();
  res.on("close", () => { if (!res.writableEnded) upstreamController.abort(); }); // not req "close": on Node 16+ that fires as soon as the body is read

  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "server_not_configured", message: "ANTHROPIC_API_KEY is not set on the server." });
    }

    const body = req.body || {};
    const { cloud, iacTool, pipelineTool } = normalizeStackFields(body);
    const { request: userReq, existingIac, existingPipeline } = body;
    if (!userReq && !existingIac && !existingPipeline) {
      return res.status(400).json({ error: "bad_request", message: "Provide a request, existing IaC, or existing pipeline." });
    }

    const prompt = buildPrompt({ cloud, iacTool, pipelineTool, userReq, existingIac, existingPipeline });

    startKeepalive(res);
    let raw, stopReason;
    try {
      // Bumped from 16000: a restructured multi-file folder layout needs more
      // room than the old single IaC + single pipeline snippet did.
      ({ text: raw, stopReason } = await callAnthropicStreaming({ maxTokens: 48000, prompt, signal: upstreamController.signal }));
    } catch (err) {
      if (err.name === "AbortError" || upstreamController.signal.aborted) {
        console.log("Generation aborted (client disconnected or clicked Stop).");
        return;
      }
      console.error("Anthropic API error:", err.status, err.message);
      const detail = extractErrorDetail(err.message);
      return res.status(502).json({
        error: "upstream_error",
        message: `Anthropic API returned ${err.status}: ${String(detail).slice(0, 400)}`,
      });
    }

    if (stopReason === "max_tokens") {
      console.error("Model output truncated at max_tokens:", raw);
      return res.status(502).json({
        error: "truncated",
        message: "The model's response was cut off before it finished. Try a shorter/simpler request.",
        raw,
      });
    }

    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch (e) {
      console.error("Failed to parse model output as JSON:", raw);
      return res.status(502).json({
        error: "parse_error",
        message: `Model did not return valid JSON. First 300 chars of its response: ${raw.slice(0, 300)}`,
        raw,
      });
    }

    res.json(parsed);
  } catch (err) {
    console.error("Unexpected error in /api/generate:", err);
    res.status(500).json({ error: "internal_error", message: String(err && err.message ? err.message : err) });
  }
});

function buildSolutionPrompt({ cloud, iacTool, pipelineTool, userReq, environments }) {
  const envList = (environments && environments.length ? environments : ["dev", "qa", "staging", "prod"]).join(", ");

  const iacLabel = iacTool || "the IaC tool you judge fits best";
  return `You are an AI DevOps engineer producing a COMPLETE, end-to-end DevOps solution package for a real request — not a single snippet, but the full set of files a team would need to adopt this.

${describeStackChoice("Target cloud", cloud)} ${describeStackChoice("Infrastructure-as-code tool", iacTool)} ${describeStackChoice("Pipeline tool", pipelineTool)} Target environments: ${envList}.

Request:
"""
${userReq}
"""

Produce a complete solution: environment-separated IaC (one set of files per environment or a modular structure with per-environment tfvars/parameters — your judgment on which fits ${iacLabel} best), a full multi-stage pipeline covering all listed environments with approval gates between them, a security scanning gate appropriate to the stack (Checkov/tfsec for IaC, Trivy for containers, gitleaks for secrets), and a README explaining what was generated, how to adopt it, and what to check before applying it.

Use placeholders (ACCOUNT_ID, <SUBSCRIPTION_ID>, etc.) for anything account/environment-specific. Keep each file realistic and focused — this should look like something a competent engineer wrote, not exhaustive generated boilerplate.

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:
{
  "explanation": "string - 2-3 sentences for a non-technical audience on what this solution does",
  "manifest": [{"path": "string - file path", "purpose": "string - one line on what this file does"}],
  "files": [{"path": "string - same paths as manifest", "content": "string - the raw file content, no markdown fences inside"}],
  "readme": "string - a full README.md explaining the solution and adoption steps",
  "manual_effort_today": "string - realistic, conservative estimate for a person to build this by hand",
  "with_ai_estimate": "string - realistic estimate for generating this plus human review"
}`;
}

app.post("/api/generate-solution", async (req, res) => {
  res.on("error", () => {}); // swallow write errors on an already-closed (aborted) connection
  const upstreamController = new AbortController();
  res.on("close", () => { if (!res.writableEnded) upstreamController.abort(); }); // not req "close": on Node 16+ that fires as soon as the body is read

  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "server_not_configured", message: "ANTHROPIC_API_KEY is not set on the server." });
    }

    const body = req.body || {};
    const { cloud, iacTool, pipelineTool } = normalizeStackFields(body);
    const { request: userReq, environments } = body;
    if (!userReq) {
      return res.status(400).json({ error: "bad_request", message: "Describe the solution you need." });
    }

    const prompt = buildSolutionPrompt({ cloud, iacTool, pipelineTool, userReq, environments });

    startKeepalive(res);
    let raw, stopReason;
    try {
      ({ text: raw, stopReason } = await callAnthropicStreaming({ maxTokens: 64000, prompt, signal: upstreamController.signal }));
    } catch (err) {
      if (err.name === "AbortError" || upstreamController.signal.aborted) {
        console.log("Generation aborted (client disconnected or clicked Stop).");
        return;
      }
      console.error("Anthropic API error:", err.status, err.message);
      const detail = extractErrorDetail(err.message);
      return res.status(502).json({
        error: "upstream_error",
        message: `Anthropic API returned ${err.status}: ${String(detail).slice(0, 400)}`,
      });
    }

    if (stopReason === "max_tokens") {
      console.error("Model output truncated at max_tokens:", raw);
      return res.status(502).json({
        error: "truncated",
        message: "The model's response was cut off before it finished. Try fewer environments or a narrower request.",
        raw,
      });
    }

    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch (e) {
      console.error("Failed to parse solution output as JSON:", raw);
      return res.status(502).json({
        error: "parse_error",
        message: `Model did not return valid JSON. First 300 chars of its response: ${raw.slice(0, 300)}`,
        raw,
      });
    }

    res.json(parsed);
  } catch (err) {
    console.error("Unexpected error in /api/generate-solution:", err);
    res.status(500).json({ error: "internal_error", message: String(err && err.message ? err.message : err) });
  }
});

// Placeholder for future git-integrated delivery. Intentionally not implemented:
// it needs real, per-project repo credentials (PAT / GitHub App / Azure DevOps
// service connection) that don't exist yet under the current access model.
// When that access exists, this is where a "create branch + commit files +
// open PR" call to the GitHub/Azure DevOps REST API would go — reusing the
// same `files` array /api/generate-solution already produces.
app.post("/api/push-to-git", (req, res) => {
  res.status(501).json({
    error: "not_implemented",
    message: "Git push is not enabled yet — it needs repo credentials that aren't available under the current access model. Download the bundle and hand it to the project team for now.",
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: MODEL, configured: Boolean(API_KEY) });
});

app.listen(PORT, () => {
  console.log(`AI Pipeline & Environment Generator listening on port ${PORT}`);
});
