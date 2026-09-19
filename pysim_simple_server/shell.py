import importlib.util
import os
import sys


def load_pysim_app():
    import pySim
    pysim_dir = os.path.dirname(pySim.__file__)
    candidates = [
        os.path.join(os.path.dirname(pysim_dir), 'pySim-shell.py'),
        os.path.join(os.path.dirname(sys.executable), 'pySim-shell.py'),
    ]
    for path in candidates:
        if os.path.exists(path):
            spec = importlib.util.spec_from_file_location("pySim_shell", path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise ImportError(
        "pySim-shell.py not found. Make sure pysim is installed "
        "(pip install pysim) and pySim-shell.py is on the PATH."
    )