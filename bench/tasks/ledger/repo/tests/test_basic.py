import unittest
from decimal import Decimal

from ledger import Ledger, LedgerError


class BasicTest(unittest.TestCase):
    def setUp(self):
        self.l = Ledger()
        self.l.open_account("Cash", "asset")
        self.l.open_account("Sales", "income")

    def test_post_and_balance(self):
        tid = self.l.post("2026-01-05", "sale", [("Cash", "100.00"), ("Sales", "-100.00")])
        self.assertEqual(tid, 1)
        self.assertEqual(self.l.balance("Cash"), Decimal("100.00"))
        self.assertEqual(self.l.balance("Sales"), Decimal("100.00"))

    def test_unbalanced_is_rejected(self):
        with self.assertRaises(LedgerError):
            self.l.post("2026-01-05", "bad", [("Cash", "10"), ("Sales", "-9.99")])
        self.assertEqual(self.l.balance("Cash"), Decimal("0.00"))

    def test_duplicate_account(self):
        with self.assertRaises(LedgerError):
            self.l.open_account("cash", "asset")


if __name__ == "__main__":
    unittest.main()
