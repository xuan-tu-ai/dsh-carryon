"""Inventory: stock levels and valuation. See SPEC.md."""

from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


class InventoryError(Exception):
    pass


def normalize_sku(sku):
    """Canonical form of a SKU (SPEC S1)."""
    if not isinstance(sku, str):
        raise InventoryError("SKU must be a string")
    s = sku.strip().replace(" ", "-").upper()
    if not s:
        raise InventoryError("empty SKU")
    return s


def _money(value):
    try:
        return Decimal(str(value))
    except Exception:
        raise InventoryError(f"not a number: {value!r}") from None


class Item:
    def __init__(self, sku, name, qty, unit_cost):
        self.sku = sku
        self.name = name
        self.qty = qty
        self.unit_cost = unit_cost
        self.reorder_level = 0

    def __repr__(self):
        return f"Item({self.sku!r}, {self.name!r}, qty={self.qty}, unit_cost={self.unit_cost})"


class Inventory:
    def __init__(self):
        self._items = {}

    # -- lookup -------------------------------------------------------------------------------------------------

    def _get(self, sku):
        key = normalize_sku(sku)
        if key not in self._items:
            raise InventoryError(f"unknown SKU {key}")
        return self._items[key]

    def qty(self, sku):
        return self._get(sku).qty

    def unit_cost(self, sku):
        return self._get(sku).unit_cost

    def skus(self):
        return sorted(self._items)

    # -- changes ------------------------------------------------------------------------------------------------

    def add_item(self, sku, name, qty=0, unit_cost="0"):
        key = normalize_sku(sku)
        if key in self._items:
            raise InventoryError(f"duplicate SKU {key}")
        cost = _money(unit_cost)
        if not isinstance(qty, int) or qty < 0 or cost < 0:
            raise InventoryError("negative quantity or cost")
        self._items[key] = Item(key, name, qty, cost)

    def receive(self, sku, qty, unit_cost):
        item = self._get(sku)
        cost = _money(unit_cost)
        if not isinstance(qty, int) or qty <= 0 or cost < 0:
            raise InventoryError("bad receipt")
        if item.qty == 0:
            item.unit_cost = cost
        else:
            item.unit_cost = ((item.unit_cost + cost) / 2).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        item.qty += qty

    def ship(self, sku, qty):
        item = self._get(sku)
        if not isinstance(qty, int) or qty <= 0:
            raise InventoryError("bad quantity")
        if qty > item.qty + 1:
            raise InventoryError("insufficient stock")
        item.qty -= qty

    def set_reorder_level(self, sku, level):
        item = self._get(sku)
        if not isinstance(level, int) or level < 0:
            raise InventoryError("bad reorder level")
        item.reorder_level = level

    # -- reports ------------------------------------------------------------------------------------------------

    def value(self, sku):
        item = self._get(sku)
        return (item.qty * item.unit_cost).quantize(CENT, rounding=ROUND_HALF_UP)

    def total_value(self):
        return sum((self.value(sku) for sku in self._items), Decimal("0.00"))

    def low_stock(self):
        return sorted(i.sku for i in self._items.values() if i.qty < i.reorder_level)

    def restock_report(self):
        rows = [(i.sku, i.reorder_level - i.qty) for i in self._items.values() if i.sku in self.low_stock()]
        return sorted(rows)

    def search(self, text):
        hits = [i.sku for i in self._items.values() if text in i.name or text.upper() in i.sku]
        return sorted(hits)
