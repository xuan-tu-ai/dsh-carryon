import unittest
from decimal import Decimal

from inventory import Inventory, InventoryError


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.inv = Inventory()
        self.inv.add_item("bolt-1", "Steel bolt", qty=10, unit_cost="1.00")

    def test_weighted_average_cost(self):
        self.inv.receive("BOLT-1", 30, "2.00")
        self.assertEqual(self.inv.unit_cost("bolt-1"), Decimal("1.7500"))
        self.assertEqual(self.inv.qty("bolt-1"), 40)

    def test_cannot_ship_more_than_on_hand(self):
        with self.assertRaises(InventoryError):
            self.inv.ship("bolt-1", 11)
        self.assertEqual(self.inv.qty("bolt-1"), 10)

    def test_low_stock_includes_reorder_level(self):
        self.inv.set_reorder_level("bolt-1", 10)
        self.assertEqual(self.inv.low_stock(), ["BOLT-1"])

    def test_value(self):
        self.assertEqual(self.inv.value("bolt-1"), Decimal("10.00"))


if __name__ == "__main__":
    unittest.main()
