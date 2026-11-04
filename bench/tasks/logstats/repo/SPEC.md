# logstats: access-log statistics

Python 3.11+, standard library only. Run as `python3 logstats.py LOGFILE COMMAND [OPTIONS]`.

## L1. Log lines

Each line looks like
`IP - - [DD/Mon/YYYY:HH:MM:SS +0000] "METHOD PATH PROTOCOL" STATUS BYTES "REFERER" "USER-AGENT"`.
`BYTES` is a number or `-` (counted as 0). A line that does not match this format (including a blank line or an
impossible date) is malformed: it is counted and otherwise ignored. Times are reported in UTC as
`YYYY-MM-DDTHH:MM:SSZ`. The path of a request is the `PATH` without its query string (the part from `?` on).

## L2. `summary`

Prints, in this order: `requests` (well-formed lines), `malformed`, `unique_ips`, `bytes` (sum), `status` (an
object with the keys `2xx`, `3xx`, `4xx`, `5xx`, always all four, counting statuses 200–299 and so on), `first`
and `last` (the earliest and latest request time, `null` when there are no requests).

## L3. `top --by FIELD [--n N]`

`FIELD` is `ip`, `path`, `status` or `ua`. Prints the `N` (default 5, must be ≥ 1) most frequent values as
`[value, count]` pairs, by count descending and then by value ascending (statuses compared as strings).

## L4. `errors [--since TIME]`

Prints the requests with a 5xx status as objects `{"time", "ip", "method", "path", "status"}` (status as a
number), in time order; requests with the same time keep their order in the file. With `--since`
(`YYYY-MM-DDTHH:MM:SSZ`), only requests at or after that time.

## L5. `hourly`

Prints an object mapping each hour `YYYY-MM-DDTHH` from the hour of the first request to the hour of the last
one, both included, to its number of requests (hours without requests map to 0), in time order. With no
requests, an empty object.

## L6. Output formats

`--format json` prints the result as a single JSON document. `--format text`, the default, prints:
- `summary`: one `key: value` line per key; `status` becomes four lines `status.2xx: N` …; `null` is printed as `-`.
- `top`: one `COUNT<TAB>VALUE` line per pair.
- `errors`: one `TIME IP METHOD PATH STATUS` line per request (single spaces).
- `hourly`: one `HOUR<TAB>COUNT` line per hour.
An empty result prints nothing in text format.

## L7. Exit codes

0 on success. 2 for a usage error (unknown command or option, missing `--by`, bad `--by` value, `--n` not a
positive integer, bad `--since`), with a message on stderr and nothing on stdout. 1 when the log file cannot be
read, with a message on stderr.
