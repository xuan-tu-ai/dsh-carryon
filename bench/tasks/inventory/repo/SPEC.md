# inventory: stock levels and valuation

Python 3.11+, standard library only. Module `inventory`, classes `Inventory` and `InventoryError`.
Money is `decimal.Decimal`; quantities are non-negative integers.

## S1. SKUs

A SKU is normalized before every use: surrounding whitespace removed, inner whitespace and underscores replaced
by `-`, runs of `-` collapsed to one, letters upper-cased. `" ab_ 12 "` becomes `"AB-12"`. A SKU that is empty
after normalization is an error.

## S2. Adding items

`add_item(sku, name, qty=0, unit_cost="0")` adds an item. A SKU that already exists (after normalization) is an
error, as is a negative quantity or cost. `name` is stored with surrounding whitespace removed.

## S3. Receiving stock

`receive(sku, qty, unit_cost)` adds `qty > 0` units bought at `unit_cost`. The item's unit cost becomes the
quantity-weighted average of the units on hand and the units received, rounded to 4 decimal places
(`ROUND_HALF_UP`). Receiving into an item with no units on hand sets the unit cost to `unit_cost`.

## S4. Shipping

`ship(sku, qty)` removes `qty > 0` units. Shipping more than is on hand is an error and changes nothing.
Shipping does not change the unit cost.

## S5. Valuation

`value(sku)` is `qty * unit_cost` and `total_value()` the sum over all items, each rounded to cents
(`ROUND_HALF_UP`) after summing (not per item).

## S6. Low stock and restocking

Each item has a `reorder_level` (default 0), set with `set_reorder_level(sku, level)`. `low_stock()` returns the
SKUs whose quantity is at or below their reorder level, sorted. `restock_report()` returns
`(sku, shortfall)` pairs, where shortfall = reorder level - quantity + 1, for low-stock items, sorted by shortfall
descending and then SKU ascending.

## S7. Search

`search(text)` returns the SKUs of items whose name or SKU contains `text`, ignoring case, sorted. Matching on
SKU compares with the normalized form of `text` as well as with `text` itself.

## S8. Errors

Every rejected call raises `InventoryError` (unknown SKU included) and leaves the inventory unchanged.
