from __future__ import annotations

import torch
from app.schemas.models import ManufacturingConstraints


def compile_token_masks(word_to_id, constraints: ManufacturingConstraints, max_layers, device):
    size = max(word_to_id.values()) + 1
    required = max([1] + [rule.index for rule in constraints.layers])
    if required > max_layers:
        raise ValueError("逐层约束编号不能超过最大层数")
    masks = []
    for index in range(1, max_layers + 1):
        rule = next((rule for rule in constraints.layers if rule.index == index), None)
        low = max(constraints.min_thickness_nm, (rule.min_nm if rule else None) or constraints.min_thickness_nm)
        high = min(constraints.max_thickness_nm, (rule.max_nm if rule else None) or constraints.max_thickness_nm)
        mask = torch.zeros(size, dtype=torch.bool, device=device)
        for token, token_id in word_to_id.items():
            try:
                material, thickness = token.rsplit('_', 1)
                thickness = float(thickness)
            except (ValueError, TypeError):
                continue
            if (low <= thickness <= high and (not rule or rule.material is None or material == rule.material)
                    and (not rule or rule.thickness_nm is None or abs(thickness - rule.thickness_nm) < 1e-8)):
                mask[token_id] = True
        if not mask.any():
            raise ValueError(f"第 {index} 层没有符合工艺边界的模型 token；请检查材料词表和离散厚度（锁定值不会自动取整）")
        if index > required:
            mask[word_to_id['EOS']] = True
        masks.append(mask)
    return masks


def check_structure(tokens, constraints: ManufacturingConstraints):
    required = max([1] + [rule.index for rule in constraints.layers])
    if len(tokens) < required:
        raise ValueError("候选缺少要求锁定或约束的膜层")
    for index, token in enumerate(tokens, 1):
        material, thickness = token.rsplit('_', 1)
        thickness = float(thickness)
        rule = next((rule for rule in constraints.layers if rule.index == index), None)
        low = max(constraints.min_thickness_nm, (rule.min_nm if rule else None) or constraints.min_thickness_nm)
        high = min(constraints.max_thickness_nm, (rule.max_nm if rule else None) or constraints.max_thickness_nm)
        if (not low <= thickness <= high or (rule and rule.material is not None and material != rule.material)
                or (rule and rule.thickness_nm is not None and abs(thickness - rule.thickness_nm) > 1e-8)):
            raise ValueError(f"候选第 {index} 层违反工艺边界")
