"""Reference solution for the logstats benchmark task (used only to check the hidden tests)."""

import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

LINE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] "(?P<method>\S+) (?P<path>\S+) (?P<proto>[^"\s]+)" '
    r'(?P<status>\d{3}) (?P<bytes>\d+|-) "(?P<ref>[^"]*)" "(?P<ua>[^"]*)"$'
)


class Usage(Exception):
    pass


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(lines):
    reqs, bad = [], 0
    for line in lines:
        m = LINE.match(line.rstrip("\n"))
        try:
            t = datetime.strptime(m["time"], "%d/%b/%Y:%H:%M:%S %z").astimezone(timezone.utc) if m else None
        except ValueError:
            t = None
        if t is None:
            bad += 1
            continue
        reqs.append({"time": t, "ip": m["ip"], "method": m["method"], "path": m["path"].split("?", 1)[0],
                     "status": int(m["status"]), "bytes": 0 if m["bytes"] == "-" else int(m["bytes"]), "ua": m["ua"]})
    return reqs, bad


def summary(reqs, bad):
    times = [r["time"] for r in reqs]
    status = {k: 0 for k in ("2xx", "3xx", "4xx", "5xx")}
    for r in reqs:
        key = f"{r['status'] // 100}xx"
        if key in status:
            status[key] += 1
    return {"requests": len(reqs), "malformed": bad, "unique_ips": len({r["ip"] for r in reqs}),
            "bytes": sum(r["bytes"] for r in reqs), "status": status,
            "first": iso(min(times)) if times else None, "last": iso(max(times)) if times else None}


def top(reqs, by, n):
    counts = Counter(str(r[by]) for r in reqs)
    return [[v, c] for v, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def errors(reqs, since):
    rows = [r for r in reqs if r["status"] >= 500 and (since is None or r["time"] >= since)]
    rows.sort(key=lambda r: r["time"])
    return [{"time": iso(r["time"]), "ip": r["ip"], "method": r["method"], "path": r["path"], "status": r["status"]}
            for r in rows]


def hourly(reqs):
    if not reqs:
        return {}
    hours = Counter(r["time"].strftime("%Y-%m-%dT%H") for r in reqs)
    start = min(r["time"] for r in reqs).replace(minute=0, second=0)
    end = max(r["time"] for r in reqs).replace(minute=0, second=0)
    out = {}
    while start <= end:
        key = start.strftime("%Y-%m-%dT%H")
        out[key] = hours.get(key, 0)
        start += timedelta(hours=1)
    return out


def text(command, result):
    if command == "summary":
        lines = []
        for k, v in result.items():
            if k == "status":
                lines += [f"status.{s}: {n}" for s, n in v.items()]
            else:
                lines.append(f"{k}: {'-' if v is None else v}")
        return lines
    if command == "top":
        return [f"{c}\t{v}" for v, c in result]
    if command == "errors":
        return [f"{r['time']} {r['ip']} {r['method']} {r['path']} {r['status']}" for r in result]
    return [f"{h}\t{c}" for h, c in result.items()]


def parse_args(args):
    if len(args) < 2:
        raise Usage("usage: logstats.py LOGFILE COMMAND [OPTIONS]")
    path, command, rest = args[0], args[1], args[2:]
    if command not in ("summary", "top", "errors", "hourly"):
        raise Usage(f"unknown command {command}")
    allowed = {"summary": {"--format"}, "top": {"--format", "--by", "--n"}, "errors": {"--format", "--since"},
               "hourly": {"--format"}}[command]
    opts = {}
    i = 0
    while i < len(rest):
        key = rest[i]
        if key not in allowed or i + 1 >= len(rest):
            raise Usage(f"bad option {key}")
        opts[key] = rest[i + 1]
        i += 2
    if opts.get("--format", "text") not in ("text", "json"):
        raise Usage("bad --format")
    if command == "top":
        if opts.get("--by") not in ("ip", "path", "status", "ua"):
            raise Usage("bad or missing --by")
        if not re.fullmatch(r"[1-9]\d*", opts.get("--n", "5")):
            raise Usage("bad --n")
    if "--since" in opts:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", opts["--since"]):
            raise Usage("bad --since")
        try:
            opts["--since"] = datetime.strptime(opts["--since"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            raise Usage("bad --since") from None
    return path, command, opts


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        path, command, opts = parse_args(argv)
    except Usage as e:
        print(e, file=sys.stderr)
        return 2
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            reqs, bad = parse(f)
    except OSError as e:
        print(f"cannot read {path}: {e}", file=sys.stderr)
        return 1
    if command == "summary":
        result = summary(reqs, bad)
    elif command == "top":
        result = top(reqs, opts["--by"], int(opts.get("--n", "5")))
    elif command == "errors":
        result = errors(reqs, opts.get("--since"))
    else:
        result = hourly(reqs)
    if opts.get("--format", "text") == "json":
        print(json.dumps(result))
    else:
        for line in text(command, result):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
