"""Grade a benchmark run: run a task's hidden tests against a work directory and print JSON.

Usage: python3 bench/grade.py <workdir> <hidden-tests-dir>

The hidden tests are copied into <workdir>/_bench_hidden/ (they are not there during the run) and run with
unittest from <workdir>, in a subprocess with a time limit. Output: {"tests", "passed", "failed", "errors",
"timeout", "failures": [test ids]}.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

RUNNER = r"""
import json, sys, unittest
suite = unittest.defaultTestLoader.discover("_bench_hidden", top_level_dir=".")
result = unittest.TestResult()
suite.run(result)
bad = [t.id() for t, _ in result.failures + result.errors]
print(json.dumps({"tests": result.testsRun, "failed": len(result.failures), "errors": len(result.errors),
                  "failures": bad}))
"""


def grade(workdir: Path, hidden: Path, timeout: int = 300) -> dict:
    target = workdir / "_bench_hidden"
    shutil.rmtree(target, ignore_errors=True)
    shutil.copytree(hidden, target)
    (target / "__init__.py").touch()
    try:
        proc = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, '.'); " + RUNNER],
                              cwd=workdir, capture_output=True, text=True, timeout=timeout)
        out = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else None
    except subprocess.TimeoutExpired:
        out = None
        timed_out = True
    else:
        timed_out = False
    finally:
        shutil.rmtree(target, ignore_errors=True)
    if out is None:
        return {"tests": 0, "passed": 0, "failed": 0, "errors": 1, "timeout": timed_out, "failures": ["<runner>"]}
    out["passed"] = out["tests"] - out["failed"] - out["errors"]
    out["timeout"] = False
    return out


if __name__ == "__main__":
    print(json.dumps(grade(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())))
