# TMM + OptoGPT

This repository combines the existing transfer-matrix-method (TMM) optics
package with a local OptoGPT deployment for multilayer thin-film inverse
design.

## Repository layout

- `tmm/` - the original TMM forward solver and its tests and examples.
- `third_party/optogpt/` - a source snapshot of the upstream OptoGPT project.
- `inverse_design/` - local inference integration for generating candidate
  material and thickness sequences.
- `targets/` - target reflection/transmission spectra.
- `models/optogpt/` - local pretrained weights and download instructions.
- `papers/` - project reference material.

## Environment

The tested OptoGPT environment uses Python 3.8, PyTorch 2.0.1, and CUDA 11.8.
After installing the appropriate CPU or CUDA build of PyTorch, install the
remaining dependencies and the local TMM package from the repository root:

```powershell
python -m pip install -r .\requirements-optogpt.txt
python -m pip install -e .\tmm
```

The pretrained checkpoint is intentionally excluded from Git because it is
approximately 726 MB and exceeds GitHub's normal per-file size limit. Follow
`models/optogpt/README.md` to download it locally.

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
