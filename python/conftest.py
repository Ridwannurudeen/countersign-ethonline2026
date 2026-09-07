import importlib.util
import sys
from pathlib import Path

import x402.mechanisms


spec = importlib.util.spec_from_file_location(
    "x402.mechanisms.hedera",
    Path(__file__).parent / "x402" / "mechanisms" / "hedera" / "__init__.py",
)
hedera = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = hedera
spec.loader.exec_module(hedera)
x402.mechanisms.hedera = hedera
