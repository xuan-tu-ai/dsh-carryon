"""Inventory: stock levels and valuation. See SPEC.md."""

import re
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
COST = Decimal("0.0001")


class InventoryError(Exception):
    pass


def normalize_sku(sku):
    if not isinstance(sku, str):
        raise InventoryError("SKU must be a string")
    s = re.sub(r"[\s_]+", "-", sku.strip())
    s = re.sub(r"-+", "-", s).upper()
    if not s:
        raise InventoryError("empty SKU")
    return s


class Item:
    def __init__(self, sku, name, qty, unit_cost):
        self.sku = sku
        self.name = name
        self.qty = qty
        self.unit_cost = unit_cost
        self.reorder_level = 0


class Inventory:
    def __init__(self):
        self._items = {}

    def _get(self, sku):
        key = normalize_sku(sku)
        if key not in self._items:
            raise InventoryError(f"unknown SKU {key}")
        return self._items[key]

    def add_item(self, sku, name, qty=0, unit_cost="0"):
        key = normalize_sku(sku)
        if key in self._items:
            raise InventoryError(f"duplicate SKU {key}")
        cost = Decimal(str(unit_cost))
        if not isinstance(qty, int) or qty < 0 or cost < 0:
            raise InventoryError("negative quantity or cost")
        self._items[key] = Item(key, name.strip(), qty, cost)

    def qty(self, sku):
        return self._get(sku).qty

    def unit_cost(self, sku):
        return self._get(sku).unit_cost

    def receive(self, sku, qty, unit_cost):
        item = self._get(sku)
        cost = Decimal(str(unit_cost))
        if not isinstance(qty, int) or qty <= 0 or cost < 0:
            raise InventoryError("bad receipt")
        if item.qty == 0:
            item.unit_cost = cost
        else:
            total = item.qty * item.unit_cost + qty * cost
            item.unit_cost = (total / (item.qty + qty)).quantize(COST, rounding=ROUND_HALF_UP)
        item.qty += qty

    def ship(self, sku, qty):
        item = self._get(sku)
        if not isinstance(qty, int) or qty <= 0:
            raise InventoryError("bad quantity")
        if qty > item.qty:
            raise InventoryError("insufficient stock")
        item.qty -= qty

    def value(self, sku):
        item = self._get(sku)
        return (item.qty * item.unit_cost).quantize(CENT, rounding=ROUND_HALF_UP)

    def total_value(self):
        total = sum((i.qty * i.unit_cost for i in self._items.values()), Decimal("0"))
        return total.quantize(CENT, rounding=ROUND_HALF_UP)

    def set_reorder_level(self, sku, level):
        item = self._get(sku)
        if not isinstance(level, int) or level < 0:
            raise InventoryError("bad reorder level")
        item.reorder_level = level

    def low_stock(self):
        return sorted(i.sku for i in self._items.values() if i.qty <= i.reorder_level)

    def restock_report(self):
        rows = [(i.sku, i.reorder_level - i.qty + 1) for i in self._items.values() if i.qty <= i.reorder_level]
        return sorted(rows, key=lambda r: (-r[1], r[0]))

    def search(self, text):
        needle = text.casefold()
        try:
            sku_needle = normalize_sku(text).casefold()
        except InventoryError:
            sku_needle = needle
        hits = [i.sku for i in self._items.values()
                if needle in i.name.casefold() or needle in i.sku.casefold() or sku_needle in i.sku.casefold()]
        return sorted(hits)
