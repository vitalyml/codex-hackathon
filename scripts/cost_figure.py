"""Renders docs/images/cost.png: what one model call costs and what that means per day.

Numbers from the 2026-09-21 measurement (ADR-20260921, decision 21): 640 px frame,
one rule, gpt-4o with image detail low. Run: python3 scripts/cost_figure.py
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

PROMPT, COMPLETION = 189, 24  # tokens per call
PRICE_IN, PRICE_OUT = 2.50, 10.00  # USD per 1M tokens
CALL = (PROMPT * PRICE_IN + COMPLETION * PRICE_OUT) / 1e6
GATE_PASS = 0.2  # share of frames the gate let through in a measured session

fig, ax = plt.subplots(figsize=(9, 3.9), dpi=160)
ax.axis("off")
fig.text(
    0.5,
    0.97,
    "What one call costs, and what that means per day",
    ha="center",
    fontsize=14,
    weight="bold",
)
fig.text(
    0.5,
    0.89,
    f"gpt-4o, image detail low, 640 px frame, one rule:  {PROMPT} prompt tokens x ${PRICE_IN}/1M"
    f"  +  {COMPLETION} completion tokens x ${PRICE_OUT}/1M  =  ${CALL:.4f} per call",
    ha="center",
    fontsize=9.5,
    color="#333",
)

rows = []
for interval in (1, 2, 5, 10):
    calls = 86_400 / interval
    rows.append(
        [
            f"{interval} s",
            f"{int(calls):,}",
            f"${calls * CALL:,.1f}",
            f"${calls * CALL * GATE_PASS:,.1f}",
            f"${600 / interval * CALL:.2f}",
            f"${600 / interval * CALL * GATE_PASS:.2f}",
        ]
    )
cols = [
    "frame\ninterval",
    "frames\nper day",
    "per day, max\ngate passes all",
    "per day, typical\ngate passes ~20%",
    "10 min\nmax",
    "10 min\ntypical",
]
table = ax.table(
    cellText=rows,
    colLabels=cols,
    loc="center",
    cellLoc="center",
    colWidths=[0.11, 0.14, 0.2, 0.22, 0.12, 0.12],
    bbox=[0.04, 0.12, 0.92, 0.7],
)
table.auto_set_font_size(False)
table.set_fontsize(10)
for (r, c), cell in table.get_celld().items():
    cell.set_edgecolor("#ccc")
    if r == 0:
        cell.set_text_props(weight="bold")
        cell.set_facecolor("#eef0f5")
    elif c in (2, 3):
        cell.set_facecolor("#fbfbe6" if c == 2 else "#eaf6ea")
fig.text(
    0.5,
    0.02,
    "Cost is linear in the interval: doubling the slider halves the bill. Typical = a room where "
    "something happened now and then.",
    ha="center",
    fontsize=9,
    color="#555",
)
fig.savefig("docs/images/cost.png", bbox_inches="tight", facecolor="white")
print(f"per call ${CALL:.5f}")
