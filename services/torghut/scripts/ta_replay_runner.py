from __future__ import annotations

from importlib import import_module as _import_module
import sys as _sys

_module_name = __name__
_parent_name, _, _module_attr = _module_name.rpartition(".")
_impl = _import_module("scripts.ta_replay_runner_modules")
globals().update(_impl.__dict__)
_sys.modules[_module_name] = _impl
_parent = _sys.modules.get(_parent_name)
if _parent is not None:
    setattr(_parent, _module_attr, _impl)

if __name__ == "__main__":
    raise SystemExit(_impl.main())
