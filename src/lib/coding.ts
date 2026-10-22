import { createHash } from "crypto";
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { redis } from "@/lib/clients";
import { isAllowedCsvFileUrl } from "@/lib/input-limits";

export const SANDBOX_CSV_PATH = "/vercel/sandbox/data.csv";

const WORK_DIR = "/vercel/sandbox";
const CODE_PATH = `${WORK_DIR}/main.py`;
const RUNNER_PATH = `${WORK_DIR}/.runner.py`;
const IMAGES_PATH = `${WORK_DIR}/.images.json`;

const PYTHON_IMAGE = "vercel/sandbox/python:3.14";
const PYTHON_PACKAGES = [
  "pandas==3.1.0",
  "numpy==2.5.4",
  "matplotlib==3.11.2",
  "seaborn==0.13.2",
  "scipy==1.18.1",
  "scikit-learn==1.9.1",
  "statsmodels==0.15.0",
  "tabulate==0.10.0",
  "sympy==1.14.0",
];

const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_KEY = `sandbox:python-snapshot:${createHash("sha256")
  .update([PYTHON_IMAGE, ...PYTHON_PACKAGES].join("\n"))
  .digest("hex")
  .slice(0, 16)}`;
const SNAPSHOT_LOCK_KEY = `${SNAPSHOT_KEY}:lock`;
const SNAPSHOT_LOCK_TTL_SECONDS = 180;
const SNAPSHOT_WAIT_MS = 45_000;

const SANDBOX_TIMEOUT_MS = 60_000;
const EXECUTION_TIMEOUT_SECONDS = 40;

const MAX_CSV_BYTES = 50 * 1024 * 1024;
const MAX_STDOUT_CHARS = 20_000;
const MAX_ERROR_CHARS = 10_000;
const MAX_FIGURES = 3;
const MAX_FIGURE_BASE64_CHARS = 2 * 1024 * 1024;

const RUNNER_SOURCE = String.raw`
import base64, glob, io, json, os, sys, time, traceback

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

CODE_PATH = ${JSON.stringify(CODE_PATH)}
IMAGES_PATH = ${JSON.stringify(IMAGES_PATH)}
MAX_STDOUT_CHARS = ${MAX_STDOUT_CHARS}
MAX_FIGURES = ${MAX_FIGURES}
MAX_FIGURE_BASE64_CHARS = ${MAX_FIGURE_BASE64_CHARS}


class CappedStream(io.TextIOBase):
    def __init__(self, stream, limit):
        self.stream = stream
        self.limit = limit
        self.written = 0

    def write(self, text):
        remaining = self.limit - self.written
        if remaining > 0:
            self.stream.write(text[:remaining])
        self.written += len(text)
        return len(text)

    def flush(self):
        self.stream.flush()

    def finish(self):
        if self.written > self.limit:
            self.stream.write("\n... [output truncated]\n")
        self.stream.flush()


images = []


def add_image(data):
    encoded = base64.b64encode(data).decode("ascii")
    if len(images) < MAX_FIGURES and len(encoded) <= MAX_FIGURE_BASE64_CHARS:
        images.append(encoded)


def capture_figures(*args, **kwargs):
    for num in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(num).savefig(buffer, format="png", bbox_inches="tight")
        add_image(buffer.getvalue())
    plt.close("all")


plt.show = capture_figures

with open(CODE_PATH) as f:
    lines = f.read().split("\n")
# Drop IPython magics and shell escapes (e.g. "%matplotlib inline", "!pip install x").
source = "\n".join(
    line[: len(line) - len(line.lstrip())] + "pass" if line.lstrip().startswith(("%", "!")) else line
    for line in lines
)

stdout = CappedStream(sys.stdout, MAX_STDOUT_CHARS)
sys.stdout = stdout
started_at = time.time()
exit_code = 0
try:
    exec(compile(source, CODE_PATH, "exec"), {"__name__": "__main__"})
except SystemExit as e:
    exit_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
except BaseException:
    exc_type, exc, tb = sys.exc_info()
    while tb is not None and tb.tb_frame.f_code.co_filename != CODE_PATH:
        tb = tb.tb_next
    traceback.print_exception(exc_type, exc, tb)
    exit_code = 1
finally:
    sys.stdout = sys.__stdout__
    stdout.finish()

try:
    capture_figures()
    if not images:
        for png in sorted(set(glob.glob("**/*.png", recursive=True))):
            if os.path.getmtime(png) >= started_at:
                with open(png, "rb") as f:
                    add_image(f.read())
except BaseException:
    pass

with open(IMAGES_PATH, "w") as f:
    json.dump(images, f)

sys.exit(exit_code)
`;

export type CodeInterpreterOutput =
  | { type: "stdout" | "error"; data: string }
  | { type: "display_data"; data: { "image/png": string } };

export interface CodeInterpreterResponseData {
  status: "success" | "error";
  outputs: CodeInterpreterOutput[];
}

function truncate(text: string, maxChars: number) {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n... [output truncated]`
    : text;
}

function truncateStart(text: string, maxChars: number) {
  return text.length > maxChars
    ? `... [output truncated]\n${text.slice(-maxChars)}`
    : text;
}

async function downloadCsv(csvFileUrl: string): Promise<Buffer> {
  if (!isAllowedCsvFileUrl(csvFileUrl)) {
    throw new Error("CSV file URL is not allowed");
  }
  const response = await fetch(csvFileUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`CSV download failed with status ${response.status}`);
  }
  if (Number(response.headers.get("content-length")) > MAX_CSV_BYTES) {
    throw new Error("CSV file is too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CSV_BYTES) {
      await reader.cancel();
      throw new Error("CSV file is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function buildSnapshot(): Promise<string> {
  const sandbox = await Sandbox.create({
    image: PYTHON_IMAGE,
    resources: { vcpus: 2 },
    timeout: 5 * 60_000,
    persistent: false,
  });
  try {
    const install = await sandbox.runCommand({
      cmd: "uv",
      args: [
        "pip",
        "install",
        "--system",
        "--break-system-packages",
        "--compile-bytecode",
        "--quiet",
        ...PYTHON_PACKAGES,
      ],
      sudo: true,
    });
    if (install.exitCode !== 0) {
      throw new Error(`Package install failed: ${await install.stderr()}`);
    }

    // Builds the matplotlib font cache so executions don't pay for it.
    const warmup = await sandbox.runCommand("python3", [
      "-c",
      "import matplotlib.pyplot, numpy, pandas, scipy, seaborn, sklearn, statsmodels.api",
    ]);
    if (warmup.exitCode !== 0) {
      throw new Error(`Package warmup failed: ${await warmup.stderr()}`);
    }

    const snapshot = await sandbox.snapshot({
      expiration: SNAPSHOT_EXPIRATION_MS,
    });
    return snapshot.snapshotId;
  } catch (error) {
    await sandbox.stop().catch(() => {});
    throw error;
  }
}

async function getSnapshotId(): Promise<string> {
  const cached = await redis.get<string>(SNAPSHOT_KEY);
  if (cached) return cached;

  const locked =
    (await redis.set(SNAPSHOT_LOCK_KEY, "1", {
      nx: true,
      ex: SNAPSHOT_LOCK_TTL_SECONDS,
    })) === "OK";

  if (!locked) {
    const deadline = Date.now() + SNAPSHOT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const snapshotId = await redis.get<string>(SNAPSHOT_KEY);
      if (snapshotId) return snapshotId;
    }
  }

  try {
    const snapshotId = await buildSnapshot();
    // Expire the cache entry a day before the snapshot itself expires.
    await redis.set(SNAPSHOT_KEY, snapshotId, {
      px: SNAPSHOT_EXPIRATION_MS - 24 * 60 * 60 * 1000,
    });
    return snapshotId;
  } finally {
    if (locked) await redis.del(SNAPSHOT_LOCK_KEY).catch(() => {});
  }
}

async function isSnapshotUsable(snapshotId: string) {
  try {
    const snapshot = await Snapshot.get({ snapshotId });
    return snapshot.status === "created";
  } catch {
    return false;
  }
}

function createSandbox(snapshotId: string) {
  return Sandbox.create({
    source: { type: "snapshot", snapshotId },
    resources: { vcpus: 1 },
    timeout: SANDBOX_TIMEOUT_MS,
    persistent: false,
    networkPolicy: "deny-all",
  });
}

async function createSandboxFromSnapshot(): Promise<Sandbox> {
  const snapshotId = await getSnapshotId();
  try {
    return await createSandbox(snapshotId);
  } catch (error) {
    if (await isSnapshotUsable(snapshotId)) throw error;
    await redis.del(SNAPSHOT_KEY);
    return createSandbox(await getSnapshotId());
  }
}

/**
 * Executes Python code in a fresh Vercel Sandbox without network access and
 * returns its stdout, errors and matplotlib figures. The chat's CSV file is
 * available inside the sandbox at SANDBOX_CSV_PATH.
 * Throws when the sandbox itself fails; errors raised by the code are
 * returned as an "error" output.
 */
export async function runPython(
  code: string,
  { csvFileUrl }: { csvFileUrl?: string | null } = {}
): Promise<CodeInterpreterResponseData> {
  const csv = csvFileUrl ? await downloadCsv(csvFileUrl) : null;
  // Older chats were prompted to read the CSV straight from its S3 URL.
  const source = csvFileUrl
    ? code.split(csvFileUrl).join(SANDBOX_CSV_PATH)
    : code;

  const sandbox = await createSandboxFromSnapshot();
  try {
    await sandbox.writeFiles([
      { path: CODE_PATH, content: Buffer.from(source) },
      { path: RUNNER_PATH, content: Buffer.from(RUNNER_SOURCE) },
      ...(csv ? [{ path: SANDBOX_CSV_PATH, content: csv }] : []),
    ]);

    const command = await sandbox.runCommand({
      cmd: "timeout",
      args: [
        "--kill-after=2",
        String(EXECUTION_TIMEOUT_SECONDS),
        "python3",
        RUNNER_PATH,
      ],
      cwd: WORK_DIR,
      env: { MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1" },
      timeoutMs: (EXECUTION_TIMEOUT_SECONDS + 5) * 1000,
    });
    const [stdout, stderr, imagesFile] = await Promise.all([
      command.stdout(),
      command.stderr(),
      sandbox.readFileToBuffer({ path: IMAGES_PATH }),
    ]);

    const outputs: CodeInterpreterOutput[] = [];
    if (stdout) {
      outputs.push({ type: "stdout", data: truncate(stdout, MAX_STDOUT_CHARS) });
    }
    if (command.exitCode === 124 || command.exitCode === 137) {
      outputs.push({
        type: "error",
        data:
          command.exitCode === 124
            ? `Code execution timed out after ${EXECUTION_TIMEOUT_SECONDS} seconds.`
            : "Code execution was killed (it may have run out of memory or time).",
      });
    } else if (command.exitCode !== 0) {
      outputs.push({
        type: "error",
        data:
          truncateStart(stderr.trim(), MAX_ERROR_CHARS) ||
          `Code exited with status ${command.exitCode}.`,
      });
    }

    let images: unknown = [];
    try {
      images = imagesFile ? JSON.parse(imagesFile.toString("utf8")) : [];
    } catch {}
    if (Array.isArray(images)) {
      for (const image of images.slice(0, MAX_FIGURES)) {
        if (typeof image === "string") {
          outputs.push({ type: "display_data", data: { "image/png": image } });
        }
      }
    }

    return {
      status: outputs.some((output) => output.type === "error")
        ? "error"
        : "success",
      outputs,
    };
  } finally {
    await sandbox.stop().catch((error: unknown) => {
      console.error("Failed to stop sandbox:", error);
    });
  }
}
