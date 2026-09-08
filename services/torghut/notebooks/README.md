# Torghut notebooks

The notebooks in this directory are committed without outputs and executed in CI.

The notebook runtime copies these files into `/home/jovyan/work` on first launch so they are immediately editable while
the canonical copies remain immutable in the image.

- `00-system-flow.ipynb` through `30-capital-authority.ipynb` are generated production diagnostics notebooks.
- `40-transformer-math-from-first-principles.ipynb` is a self-contained learning notebook that derives a decoder-only
  transformer with NumPy and pairs every mathematical example with a geometric visualization. It is maintained as a
  reviewable, output-free notebook rather than generated Python source.

Validate and execute it:

```bash
uv run --frozen pytest tests/notebook_data/test_transformer_math_notebook.py -q
```

The notebook uses only the locked notebook runtime dependencies (`numpy`, `pandas`, Plotly, IPython, and nbclient); it
does not require a GPU, network access, model weights, or live Torghut data.
