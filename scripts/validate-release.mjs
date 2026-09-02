import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = (() => {
  try { return require("typescript"); }
  catch { return require("/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js"); }
})();

const yaml = (() => {
  try { return require("yaml"); }
  catch { return null; }
})();

const errors = [];
const warnings = [];
const results = {};

function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return [];
  const output = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) output.push(...walk(path, predicate));
    else if (predicate(path)) output.push(path);
  }
  return output;
}

function display(path) { return relative(root, path).replaceAll("\\", "/"); }

const sourceFiles = [
  ...walk(join(root, "src"), (path) => [".ts", ".tsx"].includes(extname(path))),
  ...walk(join(root, "tests"), (path) => [".ts", ".tsx"].includes(extname(path))),
  ...walk(join(root, "scripts"), (path) => [".ts", ".tsx"].includes(extname(path))),
];

let transpileDiagnostics = 0;
const aliasImports = [];
for (const path of sourceFiles) {
  const source = readFileSync(path, "utf8");
  const output = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
      resolveJsonModule: true,
    },
  });
  for (const diagnostic of output.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    transpileDiagnostics += 1;
    errors.push(`${display(path)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])@\/(.+?)\1/g)) {
    aliasImports.push({ path, target: match[2] });
  }
}
results.typescriptFiles = sourceFiles.length;
results.transpileDiagnostics = transpileDiagnostics;

function resolveAlias(target) {
  const base = join(root, "src", target);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(existsSync) ?? null;
}
const missingAliases = aliasImports.filter(({ target }) => !resolveAlias(target));
results.aliasImports = aliasImports.length;
results.missingAliasImports = missingAliases.length;
for (const item of missingAliases) errors.push(`${display(item.path)}: unresolved @/${item.target}`);

const jsonFiles = [join(root, "package.json"), join(root, "tsconfig.json")];
for (const path of jsonFiles) {
  try { JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { errors.push(`${display(path)}: invalid JSON: ${error.message}`); }
}
results.jsonFiles = jsonFiles.length;

const yamlFiles = [
  ...walk(join(root, ".github"), (path) => [".yml", ".yaml"].includes(extname(path))),
  ...walk(join(root, "deploy"), (path) => [".yml", ".yaml"].includes(extname(path))),
  ...walk(root, (path) => /^compose\..+\.ya?ml$/.test(relative(root, path))),
];
for (const path of yamlFiles) {
  try {
    const source = readFileSync(path, "utf8");
    if (yaml) {
      const docs = yaml.parseAllDocuments(source);
      const parseErrors = docs.flatMap((document) => document.errors);
      if (parseErrors.length) throw new Error(parseErrors.map((item) => item.message).join("; "));
    } else {
      execFileSync("python3", ["-c", "import sys,yaml; list(yaml.safe_load_all(sys.stdin.read()))"], { input: source, stdio: ["pipe", "pipe", "pipe"] });
    }
  } catch (error) {
    errors.push(`${display(path)}: invalid YAML: ${error.stderr?.toString().trim() || error.message}`);
  }
}
results.yamlFiles = yamlFiles.length;

const stagingManifestPath = join(root, "deploy/k8s/staging/all.yaml");
const expectedStagingResources = new Set([
  "Namespace/agency-os-staging",
  "ConfigMap/agency-os-config",
  "ServiceAccount/agency-os",
  "Service/agency-os-web",
  "Deployment/agency-os-web",
  "Deployment/agency-os-runner-artifact",
  "Deployment/agency-os-runner-workspace",
  "Deployment/agency-os-runner-external",
  "HorizontalPodAutoscaler/agency-os-web",
  "HorizontalPodAutoscaler/agency-os-runner-workspace",
]);
try {
  const source = readFileSync(stagingManifestPath, "utf8");
  let documents;
  if (yaml) {
    documents = yaml.parseAllDocuments(source).map((document) => document.toJSON()).filter(Boolean);
  } else {
    const raw = execFileSync("python3", ["-c", "import sys,json,yaml; print(json.dumps(list(yaml.safe_load_all(sys.stdin.read()))))"], { input: source, encoding: "utf8" });
    documents = JSON.parse(raw).filter(Boolean);
  }
  const inventory = new Set(documents.map((document) => `${document.kind}/${document.metadata?.name}`));
  results.stagingKubernetesDocuments = documents.length;
  results.stagingKubernetesResources = inventory.size;
  if (documents.length !== expectedStagingResources.size) {
    errors.push(`deploy/k8s/staging/all.yaml: expected ${expectedStagingResources.size} resources, found ${documents.length}`);
  }
  for (const expected of expectedStagingResources) {
    if (!inventory.has(expected)) errors.push(`deploy/k8s/staging/all.yaml: missing ${expected}`);
  }
  for (const actual of inventory) {
    if (!expectedStagingResources.has(actual)) warnings.push(`deploy/k8s/staging/all.yaml: unexpected resource ${actual}`);
  }
  const configMap = documents.find((document) => document.kind === "ConfigMap" && document.metadata?.name === "agency-os-config");
  const configData = configMap?.data ?? {};
  const requiredConfig = {
    AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: "true",
    AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: "false",
    AGENCY_WORKSPACE_PROVIDER: "remote-http",
    AGENCY_TRANSACTIONS_REQUIRED: "true",
  };
  for (const [key, expected] of Object.entries(requiredConfig)) {
    if (String(configData[key]) !== expected) errors.push(`deploy/k8s/staging/all.yaml: ConfigMap ${key} must be ${expected}`);
  }
  if (!String(configData.AGENCY_OIDC_ALLOWED_ISSUER_HOSTS ?? "").trim()) {
    errors.push("deploy/k8s/staging/all.yaml: ConfigMap must set AGENCY_OIDC_ALLOWED_ISSUER_HOSTS");
  }
} catch (error) {
  errors.push(`deploy/k8s/staging/all.yaml: inventory validation failed: ${error.stderr?.toString().trim() || error.message}`);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageJson.version !== "0.7.0") errors.push(`package.json version is ${packageJson.version}, expected 0.7.0`);
const dockerfileSource = readFileSync(join(root, "Dockerfile"), "utf8");
if (!dockerfileSource.includes("FROM worker-base AS remote-worker")) {
  errors.push("Dockerfile is missing the no-Docker-client remote-worker target");
}
const remoteWorkerSection = dockerfileSource.split("FROM worker-base AS remote-worker")[1]?.split(/\nFROM /)[0] ?? "";
if (/docker-cli|docker\s+socket|\/var\/run\/docker\.sock/i.test(remoteWorkerSection)) {
  errors.push("Dockerfile remote-worker target unexpectedly contains a Docker client or socket dependency");
}
results.remoteWorkerDockerDependencyFree = !/docker-cli|\/var\/run\/docker\.sock/i.test(remoteWorkerSection);

const composeM7Source = readFileSync(join(root, "compose.m7.yml"), "utf8");
if (/\/var\/run\/docker\.sock|docker\.sock/i.test(composeM7Source)) {
  errors.push("compose.m7.yml must not mount or reference a Docker socket");
}
if (!composeM7Source.includes("target: remote-worker")) {
  errors.push("compose.m7.yml does not use the remote-worker image target");
}
for (const required of [
  'AGENCY_OIDC_ALLOWED_ISSUER_HOSTS: ${AGENCY_OIDC_ALLOWED_ISSUER_HOSTS:?Set AGENCY_OIDC_ALLOWED_ISSUER_HOSTS}',
  'AGENCY_OIDC_REQUIRE_VERIFIED_EMAIL: "true"',
  'AGENCY_ALLOW_GLOBAL_INTEGRATION_FALLBACK: "false"',
]) {
  if (!composeM7Source.includes(required)) errors.push(`compose.m7.yml is missing production boundary: ${required}`);
}
results.composeM7DockerSocketFree = !/\/var\/run\/docker\.sock|docker\.sock/i.test(composeM7Source);

if (!readFileSync(join(root, "src/lib/env.ts"), "utf8").includes("agency-os-sandbox:0.7.0")) {
  errors.push("Sandbox image default is not versioned at 0.7.0");
}

const testFiles = walk(join(root, "tests"), (path) => path.endsWith(".test.ts") || path.endsWith(".test.tsx"));
results.testFiles = testFiles.length;
if (testFiles.length < 16) errors.push(`Expected at least 16 test files, found ${testFiles.length}`);

const apiRoutes = walk(join(root, "src/app/api"), (path) => path.endsWith("/route.ts"));
const publicRoutes = new Set([
  "src/app/api/health/route.ts",
  "src/app/api/auth/oidc/start/route.ts",
  "src/app/api/auth/oidc/callback/route.ts",
]);
let unprotectedRoutes = 0;
for (const path of apiRoutes) {
  const rel = display(path);
  if (publicRoutes.has(rel)) continue;
  if (!readFileSync(path, "utf8").includes("requirePrincipal")) {
    errors.push(`${rel}: protected API route does not call requirePrincipal`);
    unprotectedRoutes += 1;
  }
}
results.apiRoutes = apiRoutes.length;
results.unprotectedRoutes = unprotectedRoutes;

const envSource = readFileSync(join(root, "src/lib/env.ts"), "utf8");
const schemaKeys = new Set([...envSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]));
const exampleSource = readFileSync(join(root, ".env.example"), "utf8");
const exampleKeys = new Set([...exampleSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
const missingEnvKeys = [...schemaKeys].filter((key) => !exampleKeys.has(key));
const extraEnvKeys = [...exampleKeys].filter((key) => !schemaKeys.has(key));
for (const key of missingEnvKeys) errors.push(`.env.example is missing ${key}`);
for (const key of extraEnvKeys) warnings.push(`.env.example contains non-schema key ${key}`);
results.envSchemaKeys = schemaKeys.size;
results.envMissingFromExample = missingEnvKeys.length;
results.envExtraInExample = extraEnvKeys.length;

const tenantRepositories = [
  "project-repository.ts", "action-repository.ts", "execution-repository.ts",
  "workspace-repository.ts", "artifact-repository.ts", "admission-repository.ts",
  "outbox-repository.ts", "usage-repository.ts", "secret-repository.ts", "policy-repository.ts",
];
for (const name of tenantRepositories) {
  const source = readFileSync(join(root, "src/repositories", name), "utf8");
  if (!/tenantFilter|currentTenantId/.test(source)) errors.push(`src/repositories/${name}: no tenant-context binding found`);
}
results.tenantScopedRepositories = tenantRepositories.length;

const markdownFiles = [join(root, "README.md"), join(root, "CHANGELOG.md"), ...walk(join(root, "docs"), (path) => path.endsWith(".md"))];
let brokenLinks = 0;
for (const path of markdownFiles) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
    const raw = match[1].split("#")[0];
    if (!raw) continue;
    const target = resolve(dirname(path), decodeURIComponent(raw));
    if (!existsSync(target)) {
      errors.push(`${display(path)}: broken relative link ${match[1]}`);
      brokenLinks += 1;
    }
  }
}
results.markdownFiles = markdownFiles.length;
results.brokenRelativeLinks = brokenLinks;

const releaseFiles = [
  ...walk(join(root, "src")), ...walk(join(root, "scripts")), ...walk(join(root, "deploy")),
  ...walk(join(root, ".github")), join(root, ".env.example"), join(root, "README.md"), join(root, "CHANGELOG.md"),
].filter((path) => existsSync(path) && statSync(path).isFile());
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /AKIA[0-9A-Z]{16}/g,
  /mongodb\+srv:\/\/(?!replace-me)[^\s"']+/g,
];
let secretFindings = 0;
for (const path of releaseFiles) {
  const source = readFileSync(path, "utf8");
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) {
      errors.push(`${display(path)}: possible committed secret matching ${pattern}`);
      secretFindings += 1;
    }
  }
}
results.secretFindings = secretFindings;
const forbiddenGenerated = [
  ...walk(root, (path) => path.endsWith(".tsbuildinfo") || path.endsWith(".zip")),
  ...["node_modules", ".next", ".env.local"].map((name) => join(root, name)).filter(existsSync),
];
for (const path of forbiddenGenerated) errors.push(`${display(path)}: generated or local-only material must not be present in the release tree`);
results.forbiddenGeneratedFiles = forbiddenGenerated.length;
results.warnings = warnings;
results.errors = errors;
results.status = errors.length ? "failed" : "passed";

console.log(JSON.stringify(results, null, 2));
if (errors.length) process.exit(1);
