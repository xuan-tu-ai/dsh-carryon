"""Write a deterministic sample access log for the logstats task: python3 make_log.py <out-file>."""

import random
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

rng = random.Random(7)
ips = [f"10.0.{rng.randint(0, 9)}.{rng.randint(1, 254)}" for _ in range(60)] + ["203.0.113.9", "198.51.100.23"]
paths = ["/", "/login", "/logout", "/api/items", "/api/items/42", "/api/orders", "/static/app.js", "/static/app.css",
         "/search", "/admin", "/health", "/api/users/me", "/docs/getting-started", "/favicon.ico"]
uas = ["Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0", "Mozilla/5.0 (Macintosh) Safari/17.1", "curl/8.5.0",
       "python-requests/2.32", "Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (Windows NT 10.0) Chrome/130"]
statuses = [200] * 70 + [201] * 4 + [204] * 3 + [301] * 4 + [304] * 6 + [400] * 3 + [401] * 2 + [403] * 2 + [404] * 6 + [500] * 2 + [502] * 1 + [503] * 1
months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
t = datetime(2026, 10, 30, 22, 14, 3, tzinfo=timezone.utc)
lines = []
for i in range(2600):
    t += timedelta(seconds=rng.choice([1, 2, 3, 5, 8, 13, 30, 60, 120]))
    if rng.random() < 0.02:
        lines.append(rng.choice(["garbage line", '10.0.0.1 - - [bad time] "GET / HTTP/1.1" 200 1', "",
                                 '10.0.0.2 - - [30/Oct/2026:23:00:00 +0000] "GET /" 200 12 "-" "x"']))
        continue
    path = rng.choice(paths)
    if path in ("/search", "/api/items") and rng.random() < 0.6:
        path += f"?q={rng.choice(['shoes', 'red', 'size+9', 'x'])}&page={rng.randint(1, 4)}"
    method = rng.choice(["GET"] * 8 + ["POST", "DELETE"])
    status = rng.choice(statuses)
    size = "-" if status in (204, 304) else str(rng.randint(120, 48000))
    stamp = f"{t.day:02d}/{months[t.month - 1]}/{t.year}:{t:%H:%M:%S} +0000"
    lines.append(f'{rng.choice(ips)} - - [{stamp}] "{method} {path} HTTP/1.1" {status} {size} "-" "{rng.choice(uas)}"')
out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("\n".join(lines) + "\n")
