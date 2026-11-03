"""Hidden tests for the logstats task: one class per SPEC.md section."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def line(ip, stamp, req, status, size, ua="UA/1"):
    return f'{ip} - - [{stamp} +0000] "{req}" {status} {size} "-" "{ua}"\n'


LOG = "".join([
    line("1.1.1.1", "31/Oct/2026:09:59:59", "GET /a?q=1 HTTP/1.1", 200, 10),
    line("2.2.2.2", "31/Oct/2026:10:00:00", "POST /b HTTP/1.1", 502, "-", "Bot/2"),
    "\n",
    line("1.1.1.1", "31/Oct/2026:12:30:00", "GET /a HTTP/1.1", 304, "-"),
    "1.1.1.1 - - [31/Feb/2026:12:00:00 +0000] \"GET / HTTP/1.1\" 200 1 \"-\" \"x\"\n",
    line("3.3.3.3", "31/Oct/2026:12:30:00", "DELETE /c?x HTTP/1.1", 500, 7, "Bot/2"),
    line("2.2.2.2", "31/Oct/2026:12:45:10", "GET /a HTTP/1.1", 404, 3),
    "1.1.1.1 - - [31/Oct/2026:12:00:00 +0000] \"GET / HTTP/1.1\" 200\n",
    line("1.1.1.1", "31/Oct/2026:11:05:00", "GET /b HTTP/1.1", 201, 1000),
])


def run(*args, log=LOG):
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "access.log"
        if log is not None:
            path.write_text(log)
        proc = subprocess.run([sys.executable, "logstats.py", str(path), *args], capture_output=True, text=True,
                              timeout=60)
    return proc.returncode, proc.stdout, proc.stderr


def js(*args, log=LOG):
    code, out, err = run(*args, "--format", "json", log=log)
    assert code == 0, err
    return json.loads(out)


class L1L2Summary(unittest.TestCase):
    def test_summary(self):
        self.assertEqual(js("summary"), {
            "requests": 6, "malformed": 3, "unique_ips": 3, "bytes": 1020,
            "status": {"2xx": 2, "3xx": 1, "4xx": 1, "5xx": 2},
            "first": "2026-10-31T09:59:59Z", "last": "2026-10-31T12:45:10Z",
        })

    def test_empty(self):
        self.assertEqual(js("summary", log="junk\n"), {
            "requests": 0, "malformed": 1, "unique_ips": 0, "bytes": 0,
            "status": {"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0}, "first": None, "last": None})


class L3Top(unittest.TestCase):
    def test_top(self):
        self.assertEqual(js("top", "--by", "path"), [["/a", 3], ["/b", 2], ["/c", 1]])
        self.assertEqual(js("top", "--by", "ip", "--n", "2"), [["1.1.1.1", 3], ["2.2.2.2", 2]])
        self.assertEqual(js("top", "--by", "status", "--n", "10"),
                         [["200", 1], ["201", 1], ["304", 1], ["404", 1], ["500", 1], ["502", 1]])
        self.assertEqual(js("top", "--by", "ua", "--n", "1"), [["UA/1", 4]])


class L4Errors(unittest.TestCase):
    def test_errors(self):
        self.assertEqual(js("errors"), [
            {"time": "2026-10-31T10:00:00Z", "ip": "2.2.2.2", "method": "POST", "path": "/b", "status": 502},
            {"time": "2026-10-31T12:30:00Z", "ip": "3.3.3.3", "method": "DELETE", "path": "/c", "status": 500},
        ])
        self.assertEqual([e["status"] for e in js("errors", "--since", "2026-10-31T10:00:01Z")], [500])
        self.assertEqual(js("errors", "--since", "2026-10-31T10:00:00Z")[0]["status"], 502)

    def test_equal_times_keep_file_order(self):
        log = (line("9.9.9.9", "31/Oct/2026:10:00:00", "GET /z HTTP/1.1", 503, 1)
               + line("8.8.8.8", "31/Oct/2026:10:00:00", "GET /y HTTP/1.1", 500, 1))
        self.assertEqual([e["ip"] for e in js("errors", log=log)], ["9.9.9.9", "8.8.8.8"])


class L5Hourly(unittest.TestCase):
    def test_hourly(self):
        self.assertEqual(js("hourly"), {"2026-10-31T09": 1, "2026-10-31T10": 1, "2026-10-31T11": 1,
                                        "2026-10-31T12": 3})
        self.assertEqual(js("hourly", log=""), {})


class L6Text(unittest.TestCase):
    def test_summary_text(self):
        code, out, _ = run("summary")
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), [
            "requests: 6", "malformed: 3", "unique_ips: 3", "bytes: 1020", "status.2xx: 2", "status.3xx: 1",
            "status.4xx: 1", "status.5xx: 2", "first: 2026-10-31T09:59:59Z", "last: 2026-10-31T12:45:10Z"])
        self.assertIn("first: -", run("summary", log="")[1].splitlines())

    def test_other_text(self):
        self.assertEqual(run("top", "--by", "ip", "--n", "1")[1], "3\t1.1.1.1\n")
        self.assertEqual(run("errors", "--since", "2026-10-31T11:00:00Z")[1],
                         "2026-10-31T12:30:00Z 3.3.3.3 DELETE /c 500\n")
        self.assertEqual(run("hourly")[1].splitlines()[0], "2026-10-31T09\t1")
        self.assertEqual(run("errors", "--since", "2027-01-01T00:00:00Z")[1], "")


class L7ExitCodes(unittest.TestCase):
    def test_usage_errors(self):
        for args in [("nope",), ("top",), ("top", "--by", "host"), ("top", "--by", "ip", "--n", "0"),
                     ("top", "--by", "ip", "--n", "x"), ("errors", "--since", "yesterday"),
                     ("errors", "--since", "2026-13-01T00:00:00Z"), ("summary", "--color", "red"),
                     ("summary", "--format", "xml")]:
            code, out, err = run(*args)
            self.assertEqual((code, out), (2, ""), args)
            self.assertTrue(err.strip(), args)

    def test_missing_file(self):
        code, out, err = run("summary", log=None)
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err.strip())


if __name__ == "__main__":
    unittest.main()
