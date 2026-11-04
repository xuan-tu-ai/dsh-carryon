"""Plain-text reports over an Inventory (not covered by SPEC.md; used by the warehouse scripts)."""

from inventory import Inventory


def stock_table(inv: Inventory) -> str:
    rows = [("SKU", "QTY", "UNIT COST", "VALUE")]
    for sku in inv.skus():
        rows.append((sku, str(inv.qty(sku)), f"{inv.unit_cost(sku):.4f}", f"{inv.value(sku):.2f}"))
    widths = [max(len(r[i]) for r in rows) for i in range(4)]
    lines = ["  ".join(c.ljust(w) for c, w in zip(r, widths)) for r in rows]
    lines.append(f"TOTAL {inv.total_value():.2f}")
    return "\n".join(lines)


def restock_lines(inv: Inventory) -> list[str]:
    return [f"order {n} x {sku}" for sku, n in inv.restock_report()]
