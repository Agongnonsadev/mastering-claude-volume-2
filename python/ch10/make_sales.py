"""Chapter 10: makes the fictional export of a week's sales, and its FAQ to fix.

Run, from the python/ folder:  python -m ch10.make_sales
No call to the API. The draw is fixed: the file is the same at each run.
"""

import csv
import random
from datetime import date, timedelta
from pathlib import Path

from comptoir.prompt import load_data

FOLDER = Path(__file__).parent / "data"
SALES = FOLDER / "sales-2026-10-12.csv"
NEIGHBORHOODS = ["Akpakpa", "Cadjèhoun", "Fidjrossè", "Gbégamey", "Zogbo", "Agla"]
CHANNELS = ["whatsapp", "whatsapp", "whatsapp", "phone", "market"]

# An FAQ from Awa's website, with two errors with respect to her terms: something to
# put the text editor tool to work.
FAQ = """# Frequently asked questions — Délices d'Awa (fictional document)

## Where do you deliver?
We deliver in Cotonou and Porto-Novo.

## Is delivery free?
Yes, from 3 bottles. Below that, it costs 500 FCFA.

## How do I pay?
By Mobile Money (MTN MoMo, Moov Money) or in cash on delivery.
"""


def make() -> list[list]:
    draw = random.Random(2026)
    products = load_data()["products"]
    lines, number = [], 0
    for day in range(7):
        current_day = date(2026, 10, 12) + timedelta(days=day)
        for _ in range(draw.randint(4, 9)):  # orders per day
            number += 1
            neighborhood, channel = draw.choice(NEIGHBORHOODS), draw.choice(CHANNELS)
            for product in draw.sample(products, draw.randint(1, 3)):
                quantity = draw.randint(1, 3) if "syrup" in product["name"] else draw.randint(2, 8)
                lines.append([current_day.isoformat(), f"C-{number:04d}", product["name"], quantity,
                              product["price_fcfa"], neighborhood, channel])
    return lines


def main() -> None:
    FOLDER.mkdir(exist_ok=True)
    with SALES.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "order", "product", "quantity", "unit_price_fcfa", "neighborhood", "channel"])
        writer.writerows(make())
    (FOLDER / "faq-template.md").write_text(FAQ, encoding="utf-8")
    print(f"Written: {SALES.name} and faq-template.md")


if __name__ == "__main__":
    main()
