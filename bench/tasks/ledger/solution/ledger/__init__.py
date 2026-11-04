"""Reference solution for the ledger benchmark task (used only to check the hidden tests)."""

import copy
import csv
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date as _date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

KINDS = ("asset", "liability", "equity", "income", "expense")
DEBIT_NORMAL = {"asset", "expense"}
CENT = Decimal("0.01")


class LedgerError(Exception):
    """Raised for every rejected ledger operation."""


@dataclass
class Txn:
    id: int
    date: str
    description: str
    postings: list  # [(account key, Decimal)]
    voided: bool = False
    void_of: int | None = None


@dataclass
class Ledger:
    accounts: dict = field(default_factory=dict)  # key (casefold) -> (name, kind)
    txns: list = field(default_factory=list)

    def _key(self, name):
        if not isinstance(name, str) or name.strip().casefold() not in self.accounts:
            raise LedgerError(f"unknown account: {name!r}")
        return name.strip().casefold()

    @staticmethod
    def _date(value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise LedgerError(f"invalid date: {value!r}")
        try:
            return _date.fromisoformat(value).isoformat()
        except ValueError:
            raise LedgerError(f"invalid date: {value!r}") from None

    @staticmethod
    def _amount(value):
        try:
            return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)
        except (InvalidOperation, ValueError):
            raise LedgerError(f"invalid amount: {value!r}") from None

    def open_account(self, name, kind):
        if not isinstance(name, str) or not name.strip():
            raise LedgerError("empty account name")
        if kind not in KINDS:
            raise LedgerError(f"unknown kind: {kind!r}")
        key = name.strip().casefold()
        if key in self.accounts:
            raise LedgerError(f"duplicate account: {name!r}")
        self.accounts[key] = (name.strip(), kind)

    def _check(self, date, postings):
        d = self._date(date)
        if len(postings) < 2:
            raise LedgerError("a transaction needs at least two postings")
        rows = [(self._key(a), self._amount(x)) for a, x in postings]
        if any(x == 0 for _, x in rows):
            raise LedgerError("zero amount")
        if sum(x for _, x in rows) != 0:
            raise LedgerError("transaction does not balance")
        return d, rows

    def post(self, date, description, postings):
        d, rows = self._check(date, postings)
        txn = Txn(len(self.txns) + 1, d, description, rows)
        self.txns.append(txn)
        return txn.id

    def _movement(self, key, start=None, end=None):
        total = sum(
            (x for t in self.txns for k, x in t.postings
             if k == key and (start is None or t.date >= start) and (end is None or t.date <= end)),
            Decimal("0"),
        )
        return total if self.accounts[key][1] in DEBIT_NORMAL else -total

    def balance(self, account, as_of=None):
        end = None if as_of is None else self._date(as_of)
        return self._movement(self._key(account), end=end).quantize(CENT)

    def trial_balance(self, as_of=None):
        end = None if as_of is None else self._date(as_of)
        rows = []
        for key, (name, kind) in self.accounts.items():
            bal = self._movement(key, end=end).quantize(CENT)
            if bal != 0:
                rows.append((name, kind, bal))
        return sorted(rows, key=lambda r: (KINDS.index(r[1]), r[0].casefold()))

    def _txn(self, txn_id):
        if not isinstance(txn_id, int) or not 1 <= txn_id <= len(self.txns):
            raise LedgerError(f"unknown transaction: {txn_id!r}")
        return self.txns[txn_id - 1]

    def void(self, txn_id):
        t = self._txn(txn_id)
        if t.voided or t.void_of is not None:
            raise LedgerError(f"cannot void #{txn_id}")
        new = Txn(len(self.txns) + 1, t.date, f"VOID #{t.id}: {t.description}", [(k, -x) for k, x in t.postings],
                  void_of=t.id)
        self.txns.append(new)
        t.voided = True
        return new.id

    def is_void(self, txn_id):
        return self._txn(txn_id).voided

    def import_csv(self, text):
        groups = {}
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames != ["date", "description", "account", "amount", "txn"]:
            raise LedgerError("bad CSV header")
        for row in reader:
            groups.setdefault(row["txn"], []).append(row)
        trial = copy.deepcopy(self)
        ids = []
        for key, rows in groups.items():
            try:
                ids.append(trial.post(rows[0]["date"], rows[0]["description"],
                                      [(r["account"], r["amount"]) for r in rows]))
            except LedgerError as e:
                raise LedgerError(f"txn {key}: {e}") from None
        self.accounts, self.txns = trial.accounts, trial.txns
        return ids

    def income_statement(self, start, end):
        s, e = self._date(start), self._date(end)
        income = sum((self._movement(k, s, e) for k, (_, kind) in self.accounts.items() if kind == "income"),
                     Decimal("0")).quantize(CENT)
        expense = sum((self._movement(k, s, e) for k, (_, kind) in self.accounts.items() if kind == "expense"),
                      Decimal("0")).quantize(CENT)
        return {"income": income, "expense": expense, "net": income - expense}

    def to_json(self):
        return json.dumps({
            "accounts": [[name, kind] for name, kind in self.accounts.values()],
            "txns": [{"id": t.id, "date": t.date, "description": t.description,
                      "postings": [[self.accounts[k][0], str(x)] for k, x in t.postings],
                      "voided": t.voided, "void_of": t.void_of} for t in self.txns],
        })

    @classmethod
    def from_json(cls, text):
        data = json.loads(text)
        led = cls()
        for name, kind in data["accounts"]:
            led.open_account(name, kind)
        for t in data["txns"]:
            led.txns.append(Txn(t["id"], t["date"], t["description"],
                                [(a.casefold(), Decimal(x)) for a, x in t["postings"]], t["voided"], t["void_of"]))
        return led

