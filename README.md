# TMM + OptoGPT

This repository combines the existing transfer-matrix-method (TMM) optics
package with a local OptoGPT deployment for multilayer thin-film inverse
design.

It now includes **OptiForge**, a local-first graphical workbench. The first
release provides a multilayer stack editor, live TMM spectra, target-spectrum
templates and CSV import, background OptoGPT generation, TMM verification and
candidate comparison.

## Repository layout

- `tmm/` - the original TMM forward solver and its tests and examples.
- `third_party/optogpt/` - a source snapshot of the upstream OptoGPT project.
- `inverse_design/` - local inference integration for generating candidate
  material and thickness sequences.
- `targets/` - target reflection/transmission spectra.
- `models/optogpt/` - local pretrained weights and download instructions.
- `papers/` - project reference material.
- `app/` - FastAPI application and adapters for TMM, OptoGPT, materials and jobs.
- `frontend/` - React/TypeScript graphical interface.
- `scripts/` - one-command setup and launch helpers for Windows.

## Environment

The tested OptoGPT environment uses Python 3.8, PyTorch 2.0.1, and CUDA 11.8.
After installing the appropriate CPU or CUDA build of PyTorch, install the
remaining dependencies and the local TMM package from the repository root:

```powershell
python -m pip install -r .\requirements-optogpt.txt
python -m pip install -e .\tmm
```

## Set up and start the graphical workbench

Open the repository folder in VS Code, select the `optogpt` Conda interpreter,
and run the **Workbench: setup** task once. You can also run it from the VS
Code terminal:

```powershell
conda activate optogpt
.\scripts\setup_workbench.ps1 -Python "D:\anaconda\envs\optogpt\python.exe"
```

After setup, run the **Workbench: start** VS Code task or:

```powershell
.\scripts\start_workbench.ps1 -Python "D:\anaconda\envs\optogpt\python.exe"
```

The application starts at `http://127.0.0.1:8000` and opens the default
browser automatically. The browser is only the user interface: the model,
CUDA inference, material files and calculations remain on the local machine.

For frontend development, run the backend with `python -m app`, then run
`npm run dev` in `frontend/`. Vite proxies `/api` requests to the backend.

### First-release workflow

1. Build a layer stack and inspect the TMM R/T/A spectrum.
2. Choose a target template or import `wavelength_nm,R,T` CSV data.
3. Generate multiple structures with OptoGPT.
4. Wait while every candidate is re-simulated and ranked with TMM.
5. Compare candidates and send one back to the forward editor.
6. Save the whole session as a versioned JSON project.

The bundled checkpoint expects a 400-1100 nm target at 10 nm intervals and
generates structures from its fixed material/thickness vocabulary. The UI
shows this model boundary explicitly. Arbitrary-angle forward simulation is
available in TMM; OptoGPT candidate verification currently uses its training
condition of normal incidence.

By default the app reads `models/optogpt/optogpt.pt`. For development or a
shared model store, set `OPTOGPT_MODEL_PATH` to an absolute checkpoint path
before starting the backend.

The pretrained checkpoint is intentionally excluded from Git because it is
approximately 726 MB and exceeds GitHub's normal per-file size limit. Follow
`models/optogpt/README.md` to download it locally.

### Version 2: usability and material inspection

- Click a material card or the layer editor's `i` button to inspect raw n/k
  curves, query interpolated values, view samples and export CSV. Data comes
  from the existing local `nk` files; this release does not replace it with
  newly sourced measurements. Simulation rejects out-of-range wavelengths.
- Numeric fields show units without spinner arrows. Enter/blur commits valid
  values, Escape restores the last committed value, and arrow keys fine-tune.
- Search materials, duplicate layers, undo stack edits, and configure substrate
  thickness/coherence. The layout adapts to smaller windows.
- Switching pages preserves inverse jobs and comparison selections. Browser
  local storage restores project drafts; session storage reconnects the last
  inverse job after a same-tab refresh. Jobs still live in server memory and
  cannot resume after a backend restart. Export JSON for durable backups.
- Candidate comparison switches between R/T and retains the generation target.
  Adopting a candidate restores the same normal-incidence, incoherent glass
  substrate conditions used by verification.

After updating, rebuild with `npm run build` in `frontend/` and restart the
backend using the start command above. No checkpoint retraining is required.

### Version 3: multi-strategy inverse search

The inverse page now defaults to 300 stochastic attempts shared across four
seeds and temperatures 0.7/0.85/1.0, with top-k 10 and top-p 0.85. Greedy and
length-normalized beam search add candidates to the same pool. Every unique
structure is verified by TMM before retaining the best 20 by spectral MAE.
The UI exposes search controls, counts, provenance and a full search export.
No checkpoint retraining is required. Rebuild the frontend and restart the backend.

See [the v3 parameter and provenance guide](docs/optogpt-v3.md) for exact
semantics, compatibility notes, upstream versus new functionality, and benchmark commands.

## Run inverse design

Prepare a 71-row spectrum in `targets/target.csv`, covering 400-1100 nm in
10 nm steps with columns `wavelength_nm,R,T`, then run:

```powershell
python .\inverse_design\infer_optogpt.py
```

The script samples multiple material/thickness candidates from OptoGPT. The
candidates should subsequently be verified and ranked with the TMM forward
solver before use.

## Upstream projects

- TMM: https://github.com/sbyrnes321/tmm
- OptoGPT: https://github.com/taigaoma1997/optogpt

The third-party source remains subject to its upstream terms and attribution.
