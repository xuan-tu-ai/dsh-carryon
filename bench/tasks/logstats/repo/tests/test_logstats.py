import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

LOG = (
    '10.0.0.1 - - [30/Oct/2026:22:00:01 +0000] "GET /a?x=1 HTTP/1.1" 200 100 "-" "curl/8"\n'
    '10.0.0.2 - - [30/Oct/2026:22:10:00 +0000] "POST /b HTTP/1.1" 503 - "-" "curl/8"\n'
    'not a log line\n'
)


def run(*args, log=LOG):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "access.log"
        path.write_text(log)
        proc = subprocess.run([sys.executable, "logstats.py", str(path), *args], capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


class LogstatsTest(unittest.TestCase):
    def test_summary_json(self):
        code, out, _ = run("summary", "--format", "json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["requests"], 2)
        self.assertEqual(data["malformed"], 1)
        self.assertEqual(data["status"], {"2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1})

    def test_unknown_command(self):
        code, out, err = run("bogus")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertTrue(err)


if __name__ == "__main__":
    unittest.main()
