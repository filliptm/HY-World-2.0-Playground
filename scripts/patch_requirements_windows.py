"""Generate requirements.windows.txt by swapping the commented Windows gsplat wheel
and onnxruntime-gpu lines in the upstream requirements.txt.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "requirements.txt"
DST = ROOT / "requirements.windows.txt"

out_lines: list[str] = []
onnx_emitted = False
gsplat_emitted = False

for raw in SRC.read_text(encoding="utf-8").splitlines():
    line = raw.rstrip()
    stripped = line.lstrip()
    low = stripped.lower()

    # Linux gsplat wheel: replaced by the Windows wheel below
    if low.startswith("gsplat @") and "linux_x86_64" in low:
        continue

    # Commented Windows gsplat line: uncomment, drop trailing " for Windows" comment
    if low.startswith("# gsplat @") and "win_amd64" in low:
        pkg = stripped.lstrip("# ").strip()
        pkg = re.sub(r"\s+for\s+Windows\s*$", "", pkg, flags=re.IGNORECASE)
        out_lines.append(pkg)
        gsplat_emitted = True
        continue

    # Swap bare onnxruntime for the GPU build once
    if low == "onnxruntime":
        if not onnx_emitted:
            out_lines.append("onnxruntime-gpu==1.19.2")
            onnx_emitted = True
        continue

    # Skip the commented Windows onnxruntime-gpu note (already emitted)
    if low.startswith("# onnxruntime-gpu"):
        if not onnx_emitted:
            out_lines.append("onnxruntime-gpu==1.19.2")
            onnx_emitted = True
        continue

    out_lines.append(line)

DST.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
print(f"wrote {DST} (gsplat_win={gsplat_emitted}, onnx_gpu={onnx_emitted})")
