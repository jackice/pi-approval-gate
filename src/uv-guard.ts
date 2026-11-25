const PIP_MESSAGE = [
  "Error: pip is disabled. Use uv instead:",
  "",
  "  To install a package for a script: uv run --with PACKAGE python script.py",
  "  To add a dependency to the project: uv add PACKAGE",
  "",
].join("\n");

const PIP3_MESSAGE = PIP_MESSAGE.replace("pip is disabled", "pip3 is disabled");

const POETRY_MESSAGE = [
  "Error: poetry is disabled. Use uv instead:",
  "",
  "  To initialize a project: uv init",
  "  To add a dependency: uv add PACKAGE",
  "  To sync dependencies: uv sync",
  "  To run commands: uv run COMMAND",
  "",
].join("\n");

const VENV_MESSAGE = [
  "Error: 'python -m venv' is disabled. Use uv instead:",
  "",
  "  To create a virtual environment: uv venv",
  "",
].join("\n");

const PY_COMPILE_MESSAGE = [
  "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
  "",
  "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
  "",
].join("\n");

// Match only in command position (start, newline, after ; && || |) to avoid grep/echo arguments.
const SEGMENT_PREFIX = String.raw`(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?`;

const PIP_PATTERN = new RegExp(`${SEGMENT_PREFIX}pip\\s*(?:$|\\s)`, "m");
const PIP3_PATTERN = new RegExp(`${SEGMENT_PREFIX}pip3\\s*(?:$|\\s)`, "m");
const POETRY_PATTERN = new RegExp(`${SEGMENT_PREFIX}poetry\\s*(?:$|\\s)`, "m");
const PYTHON_PREFIX = `${SEGMENT_PREFIX}python(?:3(?:\\.\\d+)?)?\\b[^\\n;|&]*`;
const PYTHON_PIP_PATTERN = new RegExp(`${PYTHON_PREFIX}(?:\\s-m\\s*pip\\b|\\s-mpip\\b)`, "m");
const PYTHON_VENV_PATTERN = new RegExp(`${PYTHON_PREFIX}(?:\\s-m\\s*venv\\b|\\s-mvenv\\b)`, "m");
const PYTHON_PY_COMPILE_PATTERN = new RegExp(`${PYTHON_PREFIX}(?:\\s-m\\s*py_compile\\b|\\s-mpy_compile\\b)`, "m");

/**
 * Blocks disabled Python package-manager commands and suggests the uv equivalent.
 */
export function uvGuard(command: string): string | undefined {
  if (PIP_PATTERN.test(command)) return PIP_MESSAGE;
  if (PIP3_PATTERN.test(command)) return PIP3_MESSAGE;
  if (POETRY_PATTERN.test(command)) return POETRY_MESSAGE;
  if (PYTHON_PIP_PATTERN.test(command)) return PIP_MESSAGE.replace("pip is disabled", "'python -m pip' is disabled");
  if (PYTHON_VENV_PATTERN.test(command)) return VENV_MESSAGE;
  if (PYTHON_PY_COMPILE_PATTERN.test(command)) return PY_COMPILE_MESSAGE;
  return undefined;
}
