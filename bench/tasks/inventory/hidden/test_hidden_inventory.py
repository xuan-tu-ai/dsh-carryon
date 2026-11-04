"""Hidden tests for the inventory task: one class per SPEC.md section."""

import unittest
from decimal import Decimal

from inventory import Inventory, InventoryError

D = Decimal


class S1Sku(unittest.TestCase):
    def test_normalization(self):
        inv = Inventory()
        inv.add_item(" ab_ 12 ", "Widget")
        self.assertEqual(inv.qty("AB-12"), 0)
        self.assertEqual(inv.qty("ab--12"), 0)
        self.assertEqual(inv.qty("Ab__12"), 0)
        with self.assertRaises(InventoryError):
            inv.add_item("AB 12", "dup")
        with self.assertRaises(InventoryError):
            inv.add_item("   ", "empty")


class S2Add(unittest.TestCase):
    def test_add(self):
        inv = Inventory()
        inv.add_item("x", "  Hex nut  ", 5, "0.10")
        self.assertEqual(inv.search("hex nut"), ["X"])
        self.assertEqual(inv.search("  Hex"), [])
        for args in [("y", "n", -1), ("y", "n", 1, "-0.01")]:
            with self.assertRaises(InventoryError):
                inv.add_item(*args)
        with self.assertRaises(InventoryError):
            inv.qty("y")


class S3Receive(unittest.TestCase):
    def test_weighted_average(self):
        inv = Inventory()
        inv.add_item("a", "A", 3, "1.00")
        inv.receive("a", 1, "2.00")
        self.assertEqual(inv.unit_cost("a"), D("1.2500"))
        inv.receive("a", 2, "0.10")
        self.assertEqual(inv.unit_cost("a"), D("0.8667"))
        self.assertEqual(inv.qty("a"), 6)

    def test_empty_item_takes_new_cost(self):
        inv = Inventory()
        inv.add_item("a", "A", 0, "9.99")
        inv.receive("a", 4, "2.50")
        self.assertEqual(inv.unit_cost("a"), D("2.50"))

    def test_bad_receipts(self):
        inv = Inventory()
        inv.add_item("a", "A", 1, "1")
        for qty, cost in [(0, "1"), (-2, "1"), (1, "-1")]:
            with self.assertRaises(InventoryError):
                inv.receive("a", qty, cost)
        self.assertEqual((inv.qty("a"), inv.unit_cost("a")), (1, D("1")))


class S4Ship(unittest.TestCase):
    def test_ship(self):
        inv = Inventory()
        inv.add_item("a", "A", 5, "2.00")
        inv.ship("a", 5)
        self.assertEqual(inv.qty("a"), 0)
        with self.assertRaises(InventoryError):
            inv.ship("a", 1)
        inv.receive("a", 2, "3")
        with self.assertRaises(InventoryError):
            inv.ship("a", 3)
        self.assertEqual((inv.qty("a"), inv.unit_cost("a")), (2, D("3")))


class S5Value(unittest.TestCase):
    def test_round_after_summing(self):
        inv = Inventory()
        inv.add_item("a", "A", 1, "0.004")
        inv.add_item("b", "B", 1, "0.004")
        inv.add_item("c", "C", 1, "0.002")
        self.assertEqual(inv.value("a"), D("0.00"))
        self.assertEqual(inv.total_value(), D("0.01"))


class S6Restock(unittest.TestCase):
    def test_low_stock_and_report(self):
        inv = Inventory()
        for sku, qty, level in [("b", 2, 5), ("a", 5, 5), ("c", 9, 5), ("d", 0, 3), ("e", 1, 3)]:
            inv.add_item(sku, sku, qty, "1")
            inv.set_reorder_level(sku, level)
        self.assertEqual(inv.low_stock(), ["A", "B", "D", "E"])
        self.assertEqual(inv.restock_report(), [("B", 4), ("D", 4), ("E", 3), ("A", 1)])


class S7Search(unittest.TestCase):
    def test_search(self):
        inv = Inventory()
        inv.add_item("bolt_m8", "Steel Bolt M8")
        inv.add_item("nut-m8", "Hex nut M8")
        inv.add_item("wash", "Washer")
        self.assertEqual(inv.search("m8"), ["BOLT-M8", "NUT-M8"])
        self.assertEqual(inv.search("BOLT"), ["BOLT-M8"])
        self.assertEqual(inv.search("bolt_m"), ["BOLT-M8"])
        self.assertEqual(inv.search("steel"), ["BOLT-M8"])
        self.assertEqual(inv.search("zzz"), [])


class S8Errors(unittest.TestCase):
    def test_unknown(self):
        inv = Inventory()
        for call in (lambda: inv.qty("nope"), lambda: inv.ship("nope", 1), lambda: inv.receive("nope", 1, "1"),
                     lambda: inv.set_reorder_level("nope", 1), lambda: inv.value("nope")):
            with self.assertRaises(InventoryError):
                call()


if __name__ == "__main__":
    unittest.main()
