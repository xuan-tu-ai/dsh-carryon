"""Hidden tests for the ledger task: one or more per SPEC.md requirement."""

import json
import unittest
from decimal import Decimal

from ledger import Ledger, LedgerError

D = Decimal


def book():
    led = Ledger()
    for name, kind in [("Cash", "asset"), ("Bank", "asset"), ("Loan", "liability"), ("Capital", "equity"),
                       ("Sales", "income"), ("Rent", "expense"), ("Food", "expense")]:
        led.open_account(name, kind)
    return led


class R1Accounts(unittest.TestCase):
    def test_kinds_and_names(self):
        led = Ledger()
        with self.assertRaises(LedgerError):
            led.open_account("X", "revenue")
        with self.assertRaises(LedgerError):
            led.open_account("   ", "asset")
        led.open_account("  Petty Cash ", "asset")
        with self.assertRaises(LedgerError):
            led.open_account("PETTY CASH", "expense")
        self.assertEqual(led.balance("petty cash"), D("0.00"))

    def test_any_capitalization(self):
        led = book()
        led.post("2026-02-01", "x", [("cAsH", 5), ("sales", -5)])
        self.assertEqual(led.balance("CASH"), D("5.00"))


class R2Posting(unittest.TestCase):
    def test_ids_in_order(self):
        led = book()
        self.assertEqual([led.post("2026-01-01", f"t{i}", [("Cash", 1), ("Sales", -1)]) for i in range(3)], [1, 2, 3])

    def test_rounding_half_up_and_types(self):
        led = book()
        led.post("2026-01-01", "r", [("Cash", "0.005"), ("Sales", D("-0.005"))])
        self.assertEqual(led.balance("Cash"), D("0.01"))
        led.post("2026-01-01", "i", [("Cash", 2), ("Sales", -2)])
        self.assertEqual(led.balance("Cash"), D("2.01"))

    def test_rejections_leave_ledger_unchanged(self):
        led = book()
        bad = [
            ("2026-02-30", [("Cash", 1), ("Sales", -1)]),
            ("2026/01/01", [("Cash", 1), ("Sales", -1)]),
            ("2026-01-01", [("Cash", 0)]),
            ("2026-01-01", [("Cash", 1), ("Nope", -1)]),
            ("2026-01-01", [("Cash", "0.001"), ("Sales", "-0.001")]),
            ("2026-01-01", [("Cash", "1.00"), ("Sales", "-0.99")]),
            ("2026-01-01", [("Cash", "abc"), ("Sales", "-1")]),
        ]
        for date, postings in bad:
            with self.assertRaises(LedgerError, msg=f"{date} {postings}"):
                led.post(date, "bad", postings)
        self.assertEqual(led.post("2026-01-01", "ok", [("Cash", 1), ("Sales", -1)]), 1)

    def test_three_way_split(self):
        led = book()
        led.post("2026-01-01", "split", [("Rent", "60.10"), ("Food", "39.90"), ("Bank", "-100")])
        self.assertEqual(led.balance("Bank"), D("-100.00"))
        self.assertEqual(led.balance("Food"), D("39.90"))


class R3Balances(unittest.TestCase):
    def test_normal_sides(self):
        led = book()
        led.post("2026-01-01", "loan", [("Bank", 1000), ("Loan", -1000)])
        led.post("2026-01-02", "repay", [("Loan", 200), ("Bank", -200)])
        self.assertEqual(led.balance("Loan"), D("800.00"))
        self.assertEqual(led.balance("Bank"), D("800.00"))

    def test_as_of_inclusive(self):
        led = book()
        led.post("2026-01-01", "a", [("Cash", 10), ("Sales", -10)])
        led.post("2026-01-03", "b", [("Cash", 5), ("Sales", -5)])
        self.assertEqual(led.balance("Cash", as_of="2026-01-01"), D("10.00"))
        self.assertEqual(led.balance("Cash", as_of="2026-01-02"), D("10.00"))
        self.assertEqual(led.balance("Cash", as_of="2026-01-03"), D("15.00"))
        self.assertEqual(led.balance("Cash", as_of="2025-12-31"), D("0.00"))


class R4TrialBalance(unittest.TestCase):
    def test_order_and_zero_filter(self):
        led = book()
        led.open_account("apples", "expense")
        led.post("2026-01-01", "cap", [("Bank", 500), ("Capital", -500)])
        led.post("2026-01-02", "rent", [("Rent", 100), ("Bank", -100)])
        led.post("2026-01-03", "fruit", [("apples", 3), ("Cash", 3), ("Bank", -6)])
        led.post("2026-01-04", "cash out", [("Cash", -3), ("Bank", 3)])
        self.assertEqual(led.trial_balance(), [
            ("Bank", "asset", D("397.00")),
            ("Capital", "equity", D("500.00")),
            ("apples", "expense", D("3.00")),
            ("Rent", "expense", D("100.00")),
        ])
        self.assertEqual(led.trial_balance(as_of="2026-01-01"), [("Bank", "asset", D("500.00")),
                                                                 ("Capital", "equity", D("500.00"))])


class R5Void(unittest.TestCase):
    def test_void(self):
        led = book()
        tid = led.post("2026-03-01", "lunch", [("Food", "12.50"), ("Cash", "-12.50")])
        vid = led.void(tid)
        self.assertEqual(vid, 2)
        self.assertTrue(led.is_void(tid))
        self.assertFalse(led.is_void(vid))
        self.assertEqual(led.balance("Food"), D("0.00"))
        self.assertEqual(led.balance("Food", as_of="2026-02-28"), D("0.00"))
        data = json.loads(led.to_json())
        self.assertIn("VOID #1: lunch", json.dumps(data))
        for bad in (tid, vid, 99, 0):
            with self.assertRaises(LedgerError):
                led.void(bad)


class R6Import(unittest.TestCase):
    CSV = (
        "date,description,account,amount,txn\n"
        "2026-04-01,open,Bank,100,a\n"
        "2026-04-02,rent,Rent,40,b\n"
        "2026-04-01,open,Capital,-100,a\n"
        "2026-04-02,ignored,Bank,-40,b\n"
    )

    def test_grouping_and_order(self):
        led = book()
        self.assertEqual(led.import_csv(self.CSV), [1, 2])
        self.assertEqual(led.balance("Bank"), D("60.00"))
        self.assertEqual(led.income_statement("2026-04-01", "2026-04-30")["expense"], D("40.00"))
        self.assertNotIn("ignored", led.to_json())

    def test_all_or_nothing(self):
        led = book()
        bad = self.CSV + "2026-04-03,oops,Bank,5,zz-9\n2026-04-03,oops,Sales,-4,zz-9\n"
        with self.assertRaises(LedgerError) as ctx:
            led.import_csv(bad)
        self.assertIn("zz-9", str(ctx.exception))
        self.assertEqual(led.balance("Bank"), D("0.00"))
        self.assertEqual(led.post("2026-04-05", "after", [("Cash", 1), ("Sales", -1)]), 1)


class R7IncomeStatement(unittest.TestCase):
    def test_window(self):
        led = book()
        led.post("2026-05-01", "s1", [("Cash", 300), ("Sales", -300)])
        led.post("2026-05-15", "rent", [("Rent", 120), ("Cash", -120)])
        led.post("2026-05-31", "s2", [("Cash", 50), ("Sales", -50)])
        led.post("2026-06-01", "s3", [("Cash", 999), ("Sales", -999)])
        led.post("2026-05-20", "refund", [("Sales", 20), ("Cash", -20)])
        self.assertEqual(led.income_statement("2026-05-01", "2026-05-31"),
                         {"income": D("330.00"), "expense": D("120.00"), "net": D("210.00")})
        self.assertEqual(led.income_statement("2026-05-02", "2026-05-14"),
                         {"income": D("0.00"), "expense": D("0.00"), "net": D("0.00")})


class R8Persistence(unittest.TestCase):
    def test_round_trip(self):
        led = book()
        led.post("2026-01-01", "a", [("Cash", "10.10"), ("Sales", "-10.10")])
        t2 = led.post("2026-01-02", "b", [("Rent", 5), ("Cash", -5)])
        led.void(t2)
        copy = Ledger.from_json(led.to_json())
        self.assertEqual(copy.trial_balance(), led.trial_balance())
        self.assertTrue(copy.is_void(t2))
        self.assertEqual(copy.balance("cash"), D("10.10"))
        self.assertEqual(copy.post("2026-01-03", "c", [("Cash", 1), ("Sales", -1)]), 4)
        with self.assertRaises(LedgerError):
            copy.void(t2)
        with self.assertRaises(LedgerError):
            copy.open_account("CASH", "asset")


if __name__ == "__main__":
    unittest.main()
