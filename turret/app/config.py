import types

import yaml


def _to_namespace(obj):
    if isinstance(obj, dict):
        return types.SimpleNamespace(**{k: _to_namespace(v) for k, v in obj.items()})
    if isinstance(obj, list):
        return [_to_namespace(v) for v in obj]
    return obj


def load_config(path):
    with open(path, "r") as f:
        raw = yaml.safe_load(f)
    return _to_namespace(raw)
